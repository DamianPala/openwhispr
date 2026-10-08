/* White-box fixture: links resolve_paste_mode() straight out of the helper source.
 * usage: linuxAtspiTerminalFlag <force_terminal> <force_shift_insert> <atspi_terminal>
 * Prints the resolved paste mode (0 Ctrl+V, 1 Ctrl+Shift+V, 2 Shift+Insert). */
#define main helper_main
#include "../../resources/linux-fast-paste.c"
#undef main

int main(int argc, char **argv)
{
  if (argc != 4) {
    fprintf(stderr, "usage: %s <force_terminal> <force_shift_insert> <atspi_terminal>\n", argv[0]);
    return 2;
  }
  paste_mode_t mode = resolve_paste_mode(atoi(argv[1]), atoi(argv[2]), None, atoi(argv[3]));
  printf("%d\n", (int)mode);
  return 0;
}
