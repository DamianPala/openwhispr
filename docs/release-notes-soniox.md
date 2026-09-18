<!-- Rendered by scripts/ci/publish-prerelease.sh; $VERSION and $GITHUB_SHA are substituted before publishing. -->

OpenWhispr $VERSION with the Soniox realtime provider (bring your own key). Built from `${GITHUB_SHA}`.

These builds are not code-signed:

- **Windows** (`OpenWhispr.Setup.$VERSION.exe`): SmartScreen will warn; choose _More info_ → _Run anyway_.
- **macOS** (`OpenWhispr-$VERSION-arm64.dmg` for Apple Silicon, `OpenWhispr-$VERSION.dmg` for Intel): after copying the app, run `xattr -d com.apple.quarantine /Applications/OpenWhispr.app` once.
- **Linux**: AppImage (any distro) or .deb (Debian/Ubuntu).

Linux, KDE Plasma on Wayland: pasting into Chrome, Brave, VS Code and other Chromium/Electron apps needs `ydotool` (KWin's fake-input path, which the portal uses, is ignored by them). Run `sudo apt install ydotool && sudo usermod -aG input $USER`, then log out and back in; the `ydotool.service` user unit starts on login. Other apps work without it.

Soniox: paste your own API key in Settings and pick the region your key belongs to.
