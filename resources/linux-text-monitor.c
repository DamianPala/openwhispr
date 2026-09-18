/**
 * Linux Text Edit Monitor
 *
 * Uses AT-SPI2 to monitor the focused text field for value changes.
 * Outputs "CHANGED:<value>" to stdout when the text changes.
 * Exits after a timeout or on receiving a termination signal.
 *
 * The focused element is looked for inside ACTIVE toplevel windows first and
 * only then in every application's whole tree. Each AT-SPI node costs a D-Bus
 * round trip (~1.5 ms) and some applications expose enormous trees (LibreOffice
 * Writer: one node per paragraph, materialised on demand), so the search has a
 * wall-clock budget and the whole process has a hard lifetime cap; without
 * them a walk could run for hours and, being stuck in blocking calls, never
 * notice SIGTERM.
 *
 * Protocol (stdout):
 *   INITIAL_VALUE:<text>  - Initial text field value
 *   INITIAL_VALUE_B64:<base64> - Initial text field value (multiline)
 *   CHANGED:<text>        - Text field value after a change
 *   CHANGED_B64:<base64>  - Text field value after a change (multiline)
 *   EDITABLE              - Focused element is writable with no live selection (--probe-editable)
 *   NOT_EDITABLE          - Focused element is not safely writable
 *   NO_ELEMENT            - Could not get focused element
 *   NO_VALUE              - Focused element has no text value
 *
 * Input (stdin):
 *   First line: original pasted text (informational)
 *
 * Compile:
 *   gcc -O2 linux-text-monitor.c -o linux-text-monitor $(pkg-config --cflags --libs atspi-2) -lgobject-2.0
 *
 * Note: -lgobject-2.0 must be added explicitly because atspi-2.pc lists
 * gobject-2.0 under Requires.private rather than Requires, so a plain
 * `pkg-config --libs` omits it and the link fails with linkers defaulting
 * to --as-needed (e.g. current Ubuntu/Arch toolchains).
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <time.h>
#include <unistd.h>
#include <atspi/atspi.h>

#ifndef TIMEOUT_SECONDS
#define TIMEOUT_SECONDS 30
#endif
#define POLL_INTERVAL_MS 500
#define MAX_OUTPUT_CHARS 10240
#ifndef SEARCH_BUDGET_MS
#define SEARCH_BUDGET_MS 2500
#endif
#define LIFETIME_SLACK_SECONDS 10
#ifndef PROBE_LIFETIME_SECONDS
#define PROBE_LIFETIME_SECONDS 10
#endif

static struct timespec search_deadline;
static const char BASE64_TABLE[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/* Every line is flushed as it is written, so nothing is lost by leaving at
 * once. Setting a flag instead would only be honoured by the poll loop; a
 * process still walking the tree would keep going. */
static void signal_handler(int sig) {
    (void)sig;
    _exit(0);
}

static void arm_search_deadline(void) {
    clock_gettime(CLOCK_MONOTONIC, &search_deadline);
    search_deadline.tv_sec += SEARCH_BUDGET_MS / 1000;
    search_deadline.tv_nsec += (SEARCH_BUDGET_MS % 1000) * 1000000L;
    if (search_deadline.tv_nsec >= 1000000000L) {
        search_deadline.tv_sec += 1;
        search_deadline.tv_nsec -= 1000000000L;
    }
}

static int search_expired(void) {
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return now.tv_sec > search_deadline.tv_sec ||
           (now.tv_sec == search_deadline.tv_sec && now.tv_nsec >= search_deadline.tv_nsec);
}

static int has_state(AtspiAccessible *accessible, AtspiStateType state) {
    AtspiStateSet *states = atspi_accessible_get_state_set(accessible);
    if (!states) return 0;
    int result = atspi_state_set_contains(states, state);
    g_object_unref(states);
    return result;
}

static char *base64_encode(const unsigned char *data, size_t len) {
    size_t out_len = 4 * ((len + 2) / 3);
    char *out = (char *)malloc(out_len + 1);
    if (!out) return NULL;

    size_t i = 0, j = 0;
    while (i < len) {
        unsigned int octet_a = i < len ? data[i++] : 0;
        unsigned int octet_b = i < len ? data[i++] : 0;
        unsigned int octet_c = i < len ? data[i++] : 0;
        unsigned int triple = (octet_a << 16) | (octet_b << 8) | octet_c;

        out[j++] = BASE64_TABLE[(triple >> 18) & 0x3F];
        out[j++] = BASE64_TABLE[(triple >> 12) & 0x3F];
        out[j++] = BASE64_TABLE[(triple >> 6) & 0x3F];
        out[j++] = BASE64_TABLE[triple & 0x3F];
    }

    if (len % 3 == 1) {
        out[out_len - 1] = '=';
        out[out_len - 2] = '=';
    } else if (len % 3 == 2) {
        out[out_len - 1] = '=';
    }

    out[out_len] = '\0';
    return out;
}

static void print_text_output(const char *name, const char *value) {
    if (!value) return;

    size_t len = strlen(value);
    size_t limit = len < MAX_OUTPUT_CHARS ? len : MAX_OUTPUT_CHARS;

    if (memchr(value, '\n', limit) || memchr(value, '\r', limit)) {
        char *encoded = base64_encode((const unsigned char *)value, limit);
        if (!encoded) return;
        printf("%s_B64:%s\n", name, encoded);
        fflush(stdout);
        free(encoded);
        return;
    }

    printf("%s:%.*s\n", name, (int)limit, value);
    fflush(stdout);
}

static AtspiAccessible *find_focused(AtspiAccessible *accessible) {
    GError *error = NULL;

    /* The node's own state costs nothing extra (has_state below is already
     * paid for by the caller's ACTIVE check on the first level), so check it
     * before the deadline: a node reached exactly at expiry must still be
     * allowed to match instead of being dropped by search_expired(). */
    if (has_state(accessible, ATSPI_STATE_FOCUSED)) return g_object_ref(accessible);
    if (search_expired()) return NULL;

    int count = atspi_accessible_get_child_count(accessible, &error);
    if (error) {
        g_error_free(error);
        return NULL;
    }

    for (int i = 0; i < count && !search_expired(); i++) {
        AtspiAccessible *child = atspi_accessible_get_child_at_index(accessible, i, &error);
        if (error) {
            g_error_free(error);
            error = NULL;
            continue;
        }
        if (!child) continue;

        AtspiAccessible *result = find_focused(child);
        g_object_unref(child);
        if (result) return result;
    }

    return NULL;
}

/* Toolkits flag the toplevel that owns keyboard focus as ACTIVE, so its
 * subtree is where the focused element is; the other applications' trees
 * never need to be touched. */
static AtspiAccessible *find_focused_in_active_window(AtspiAccessible *app) {
    GError *error = NULL;

    int count = atspi_accessible_get_child_count(app, &error);
    if (error) {
        g_error_free(error);
        return NULL;
    }

    for (int i = 0; i < count && !search_expired(); i++) {
        AtspiAccessible *window = atspi_accessible_get_child_at_index(app, i, &error);
        if (error) {
            g_error_free(error);
            error = NULL;
            continue;
        }
        if (!window) continue;

        AtspiAccessible *result = NULL;
        if (has_state(window, ATSPI_STATE_ACTIVE)) result = find_focused(window);
        g_object_unref(window);
        if (result) return result;
    }

    return NULL;
}

/* Pass 2's full walk: same application, but every ACTIVE toplevel was
 * already exhausted by find_focused_in_active_window, so re-walking it here
 * would spend the budget twice on the same subtree for nothing. */
static AtspiAccessible *find_focused_skip_active_windows(AtspiAccessible *app) {
    GError *error = NULL;

    if (has_state(app, ATSPI_STATE_FOCUSED)) return g_object_ref(app);
    if (search_expired()) return NULL;

    int count = atspi_accessible_get_child_count(app, &error);
    if (error) {
        g_error_free(error);
        return NULL;
    }

    for (int i = 0; i < count && !search_expired(); i++) {
        AtspiAccessible *window = atspi_accessible_get_child_at_index(app, i, &error);
        if (error) {
            g_error_free(error);
            error = NULL;
            continue;
        }
        if (!window) continue;

        AtspiAccessible *result = has_state(window, ATSPI_STATE_ACTIVE) ? NULL : find_focused(window);
        g_object_unref(window);
        if (result) return result;
    }

    return NULL;
}

typedef AtspiAccessible *(*app_search_fn)(AtspiAccessible *app);

static AtspiAccessible *search_applications(AtspiAccessible *desktop, app_search_fn search) {
    GError *error = NULL;
    AtspiAccessible *focused = NULL;

    int app_count = atspi_accessible_get_child_count(desktop, &error);
    if (error) {
        g_error_free(error);
        return NULL;
    }

    for (int i = 0; i < app_count && !focused && !search_expired(); i++) {
        AtspiAccessible *app = atspi_accessible_get_child_at_index(desktop, i, &error);
        if (error) {
            g_error_free(error);
            error = NULL;
            continue;
        }
        if (!app) continue;

        focused = search(app);
        g_object_unref(app);
    }

    return focused;
}

static char *read_text_value(AtspiText *text_iface) {
    GError *error = NULL;

    int char_count = atspi_text_get_character_count(text_iface, &error);
    if (error) {
        g_error_free(error);
        return NULL;
    }
    if (char_count <= 0) return NULL;

    int limit = char_count < MAX_OUTPUT_CHARS ? char_count : MAX_OUTPUT_CHARS;
    char *value = atspi_text_get_text(text_iface, 0, limit, &error);
    if (error) {
        g_error_free(error);
        return NULL;
    }

    return value;
}

int main(int argc, char **argv) {
    signal(SIGTERM, signal_handler);
    signal(SIGINT, signal_handler);

    int probe_editable = argc >= 2 && strcmp(argv[1], "--probe-editable") == 0;

    /* Hard cap on the process lifetime, honoured even inside a blocking
     * AT-SPI call (SIGALRM's default action terminates the process). */
    alarm(probe_editable ? PROBE_LIFETIME_SECONDS : TIMEOUT_SECONDS + LIFETIME_SLACK_SECONDS);

    /* Read original text from stdin (consume but don't use) */
    char stdin_buf[4096];
    if (!probe_editable && fgets(stdin_buf, sizeof(stdin_buf), stdin)) {
        /* consumed */
    }

    int init_result = atspi_init();
    if (init_result != 0 && init_result != 1) {
        printf("NO_ELEMENT\n");
        fflush(stdout);
        return 1;
    }

    AtspiAccessible *desktop = atspi_get_desktop(0);
    if (!desktop) {
        printf("NO_ELEMENT\n");
        fflush(stdout);
        return 1;
    }

    arm_search_deadline();
    AtspiAccessible *focused = search_applications(desktop, find_focused_in_active_window);
    if (!focused) focused = search_applications(desktop, find_focused_skip_active_windows);

    g_object_unref(desktop);

    if (!focused) {
        printf("NO_ELEMENT\n");
        fflush(stdout);
        return 1;
    }

    if (probe_editable) {
        AtspiStateSet *states = atspi_accessible_get_state_set(focused);
        int editable = states &&
            atspi_state_set_contains(states, ATSPI_STATE_EDITABLE) &&
            atspi_state_set_contains(states, ATSPI_STATE_ENABLED) &&
            atspi_state_set_contains(states, ATSPI_STATE_FOCUSABLE);
        if (states) g_object_unref(states);
        /* A shell prompt must never read as a writable caret: pasted newlines
         * execute. VTE and Qt terminals expose ATSPI_ROLE_TERMINAL; the caller
         * separately refuses terminals by executable name. AT-SPI has no
         * "protected" state; password fields are told apart by role. */
        if (editable) {
            AtspiRole role = atspi_accessible_get_role(focused, NULL);
            if (role == ATSPI_ROLE_TERMINAL || role == ATSPI_ROLE_PASSWORD_TEXT) editable = 0;
        }
        /* A live selection means an EDITABLE verdict would let generated text
         * paste over the user's highlighted text. This is the authoritative
         * check: the caller's clipboard-based capture cannot see a selection
         * whose text already matches the clipboard. */
        if (editable) {
            AtspiText *probe_text = atspi_accessible_get_text_iface(focused);
            if (probe_text) {
                gint n_selections = atspi_text_get_n_selections(probe_text, NULL);
                for (gint i = 0; i < n_selections && editable; i++) {
                    AtspiRange *selection = atspi_text_get_selection(probe_text, i, NULL);
                    if (selection) {
                        if (selection->end_offset > selection->start_offset) editable = 0;
                        g_free(selection);
                    }
                }
                g_object_unref(probe_text);
            }
        }
        printf("%s\n", editable ? "EDITABLE" : "NOT_EDITABLE");
        fflush(stdout);
        g_object_unref(focused);
        return 0;
    }

    /* Monitor mode has no probe_editable gate, so it would otherwise read and
     * emit a password field's value; refuse it here the same way the probe
     * branch does (AT-SPI has no "protected" state, only the role). */
    if (atspi_accessible_get_role(focused, NULL) == ATSPI_ROLE_PASSWORD_TEXT) {
        printf("NO_VALUE\n");
        fflush(stdout);
        g_object_unref(focused);
        return 0;
    }

    /* Get the Text interface */
    AtspiText *text_iface = atspi_accessible_get_text_iface(focused);
    if (!text_iface) {
        printf("NO_VALUE\n");
        fflush(stdout);
        g_object_unref(focused);
        return 0;
    }

    /* Read initial value */
    char *last_value = read_text_value(text_iface);
    if (!last_value) {
        printf("NO_VALUE\n");
        fflush(stdout);
        g_object_unref(text_iface);
        g_object_unref(focused);
        return 0;
    }

    print_text_output("INITIAL_VALUE", last_value);

    /* Poll for changes */
    struct timespec start;
    clock_gettime(CLOCK_MONOTONIC, &start);

    for (;;) {
        struct timespec now;
        clock_gettime(CLOCK_MONOTONIC, &now);
        long elapsed_ms = (now.tv_sec - start.tv_sec) * 1000 +
                          (now.tv_nsec - start.tv_nsec) / 1000000;
        if (elapsed_ms >= TIMEOUT_SECONDS * 1000) break;

        usleep(POLL_INTERVAL_MS * 1000);

        char *current_value = read_text_value(text_iface);
        if (!current_value) continue;

        if (strcmp(current_value, last_value) != 0) {
            print_text_output("CHANGED", current_value);
            g_free(last_value);
            last_value = current_value;
        } else {
            g_free(current_value);
        }
    }

    g_free(last_value);
    g_object_unref(text_iface);
    g_object_unref(focused);

    return 0;
}
