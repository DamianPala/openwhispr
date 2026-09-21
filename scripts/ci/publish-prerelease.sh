#!/usr/bin/env bash
#
# Publishes the release/ installers as a GitHub prerelease, one asset upload at
# a time, so one failed upload (bit -soniox.2) can't leave a half-created
# release that a rerun then fails to recreate. A rerun reuses the existing
# (still-draft) release and retries per asset instead.
#
# GITHUB_SHA is the *build* commit, not necessarily the commit that dispatched
# this script: fork-prerelease.yml resolves it from the build run's headSha
# and passes it through explicitly, so a rerun still targets and credits the
# artifacts' actual source.
set -euo pipefail

: "${RELEASE_TAG:?RELEASE_TAG is required, e.g. v1.10.2-soniox.3}"
GITHUB_REPOSITORY="${GITHUB_REPOSITORY:-}"
GITHUB_SHA="${GITHUB_SHA:-}"
RELEASE_DIR="${RELEASE_DIR:-release}"
NOTES_TEMPLATE="${NOTES_TEMPLATE:-docs/release-notes-soniox.md}"
DRY_RUN="${DRY_RUN:-0}"

if [[ ! -d "$RELEASE_DIR" ]]; then
    echo "RELEASE_DIR '$RELEASE_DIR' does not exist" >&2
    exit 1
fi

file_count=$(find "$RELEASE_DIR" -maxdepth 1 -type f | wc -l)
if [[ "$file_count" -ne 5 ]]; then
    echo "Expected exactly 5 files in $RELEASE_DIR, found $file_count" >&2
    exit 1
fi

# Two versions: TAG_VERSION (title) vs. VERSION (artifact names, notes) —
# package.json/artifacts never gain the -soniox.N suffix that only the tag
# carries, so the guard below checks a prefix, not equality.
TAG_VERSION="${RELEASE_TAG#v}"

appimage=$(find "$RELEASE_DIR" -maxdepth 1 -name '*.AppImage' -print -quit)
if [[ -z "$appimage" ]]; then
    echo "No .AppImage found in $RELEASE_DIR" >&2
    exit 1
fi
appimage_basename="$(basename "$appimage")"
if [[ ! "$appimage_basename" =~ ^OpenWhispr-(.+)-linux-x86_64\.AppImage$ ]]; then
    echo "AppImage name '$appimage_basename' does not match OpenWhispr-<version>-linux-x86_64.AppImage" >&2
    exit 1
fi
VERSION="${BASH_REMATCH[1]}"
if [[ "$TAG_VERSION" != "$VERSION" && "$TAG_VERSION" != "$VERSION"-* ]]; then
    echo "Tag version ($TAG_VERSION) does not start with the AppImage version ($VERSION); wrong artifacts collected?" >&2
    exit 1
fi

# NSIS names the exe with spaces ("OpenWhispr Setup 1.10.2.exe"); GitHub
# stores it with dots. Rename first so --clobber matches on a rerun.
for file in "$RELEASE_DIR"/*; do
    base="$(basename "$file")"
    if [[ "$base" == *" "* ]]; then
        dotted="${base// /.}"
        echo "Renaming '$base' to '$dotted'"
        mv "$file" "$RELEASE_DIR/$dotted"
    fi
done

notes_file="$(mktemp)"
# The template's own $USER and backticks must survive; only these two names expand.
# shellcheck disable=SC2016
VERSION="$VERSION" GITHUB_SHA="$GITHUB_SHA" \
    envsubst '$VERSION $GITHUB_SHA' <"$NOTES_TEMPLATE" >"$notes_file"

run_gh() {
    if [[ "$DRY_RUN" == "1" ]]; then
        echo "DRY_RUN: gh $*"
    else
        gh "$@"
    fi
}

upload_with_retry() {
    local file="$1"
    local attempt
    for attempt in 1 2 3 4 5; do
        echo "Uploading $(basename "$file") (attempt $attempt/5)"
        if run_gh release upload "$RELEASE_TAG" "$file" --repo "$GITHUB_REPOSITORY" --clobber; then
            return 0
        fi
        if [[ "$attempt" -lt 5 ]]; then
            sleep $((attempt * 20))
        fi
    done
    echo "Giving up uploading $(basename "$file") after 5 attempts" >&2
    return 1
}

# A dry run must not touch the real release at all, existence check included:
# short-circuit past `gh release view` so the whole decision is printed, not made.
if [[ "$DRY_RUN" != "1" ]] && gh release view "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --json isDraft >/dev/null 2>&1; then
    echo "Reusing existing release $RELEASE_TAG"
else
    run_gh release create "$RELEASE_TAG" \
        --repo "$GITHUB_REPOSITORY" \
        --target "$GITHUB_SHA" \
        --draft \
        --prerelease \
        --title "OpenWhispr $TAG_VERSION (Soniox)" \
        --notes-file "$notes_file"
fi

for file in "$RELEASE_DIR"/*; do
    upload_with_retry "$file"
done

run_gh release edit "$RELEASE_TAG" \
    --repo "$GITHUB_REPOSITORY" \
    --draft=false \
    --prerelease \
    --notes-file "$notes_file"
