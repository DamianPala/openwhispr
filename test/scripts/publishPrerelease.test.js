const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("node:child_process");

const SCRIPT = path.join(__dirname, "../../scripts/ci/publish-prerelease.sh");
const REAL_NOTES_TEMPLATE = path.join(__dirname, "../../docs/release-notes-soniox.md");

// package.json on `daily` stays at upstream's version; nothing bumps it for a
// -soniox.N prerelease, so the tag and the artifact names disagree on purpose.
const RELEASE_TAG = "v1.10.2-soniox.3";
const TAG_VERSION = "1.10.2-soniox.3";
const VERSION = "1.10.2";
const GITHUB_SHA = "abc";
const GITHUB_REPOSITORY = "x/y";

// electron-builder's artifactName templates (electron-builder.json linux.artifactName,
// default mac/win templates) and the "Collect installers" step in
// .github/workflows/build-and-notarize.yml decide these five names. The exe
// keeps NSIS's own spaced name (no win/nsis artifactName override) — the
// script renames it to the dotted form GitHub uses before uploading.
const APPIMAGE_NAME = `OpenWhispr-${VERSION}-linux-x86_64.AppImage`;
const DEB_NAME = `OpenWhispr-${VERSION}-linux-amd64.deb`;
const EXE_NAME_ON_DISK = `OpenWhispr Setup ${VERSION}.exe`;
const EXE_NAME_UPLOADED = `OpenWhispr.Setup.${VERSION}.exe`;
const ARM64_DMG_NAME = `OpenWhispr-${VERSION}-arm64.dmg`;
const X64_DMG_NAME = `OpenWhispr-${VERSION}.dmg`;
const FILE_NAMES = [APPIMAGE_NAME, DEB_NAME, EXE_NAME_ON_DISK, ARM64_DMG_NAME, X64_DMG_NAME];
// Names as they appear in the gh log / rendered notes, i.e. after the script
// renames the spaced exe.
const UPLOADED_NAMES = FILE_NAMES.map((name) =>
  name === EXE_NAME_ON_DISK ? EXE_NAME_UPLOADED : name
);

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content);
  fs.chmodSync(filePath, 0o755);
}

// A fake `gh` in front of PATH: logs every invocation ("$*" per line) to
// FAKE_GH_LOG, and fails on cue per FAKE_GH_STATE marker files so the script's
// "reuse an existing release" and "retry a failed upload" paths both exercise.
function makeFakeGhBin(binDir) {
  writeExecutable(
    path.join(binDir, "gh"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >>"$FAKE_GH_LOG"

if [[ "\${1:-}" == "release" && "\${2:-}" == "view" ]]; then
  marker="$FAKE_GH_STATE/view-called"
  if [[ ! -f "$marker" ]]; then
    touch "$marker"
    exit 1
  fi
  exit 0
fi

if [[ "\${1:-}" == "release" && "\${2:-}" == "upload" ]]; then
  file="\${4:-}"
  if [[ "$file" == *-linux-amd64.deb ]]; then
    marker="$FAKE_GH_STATE/deb-upload-failed-once"
    if [[ ! -f "$marker" ]]; then
      touch "$marker"
      exit 1
    fi
  fi
fi

exit 0
`
  );
  // The retry loop sleeps 20s * attempt between attempts; a no-op sleep on
  // PATH keeps the failed-once-then-succeeds case fast.
  writeExecutable(
    path.join(binDir, "sleep"),
    `#!/usr/bin/env bash
exit 0
`
  );
}

function makeFixture(t, { fileNames = FILE_NAMES, appImageName = APPIMAGE_NAME } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "publish-prerelease-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const releaseDir = path.join(root, "release");
  const binDir = path.join(root, "bin");
  const stateDir = path.join(root, "state");
  const logFile = path.join(root, "gh.log");
  const notesTemplate = path.join(root, "release-notes-soniox.md");

  fs.mkdirSync(releaseDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.copyFileSync(REAL_NOTES_TEMPLATE, notesTemplate);
  makeFakeGhBin(binDir);

  for (const name of fileNames) {
    // The AppImage's own name is what the script cross-checks against the
    // tag, so let callers swap it in independently of the other four names.
    const content = name === APPIMAGE_NAME ? appImageName : name;
    fs.writeFileSync(path.join(releaseDir, name === APPIMAGE_NAME ? appImageName : name), content);
  }

  return { root, releaseDir, binDir, stateDir, logFile, notesTemplate };
}

function runScript(fixture, extraEnv = {}) {
  return spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.binDir}:${process.env.PATH}`,
      RELEASE_TAG,
      GITHUB_REPOSITORY,
      GITHUB_SHA,
      RELEASE_DIR: fixture.releaseDir,
      NOTES_TEMPLATE: fixture.notesTemplate,
      FAKE_GH_LOG: fixture.logFile,
      FAKE_GH_STATE: fixture.stateDir,
      DRY_RUN: "0",
      ...extraEnv,
    },
  });
}

function readLogLines(fixture) {
  if (!fs.existsSync(fixture.logFile)) {
    return [];
  }
  return fs
    .readFileSync(fixture.logFile, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
}

test("creates the release once, retries the asset that failed once, uploads all five, edits notes last", (t) => {
  const fixture = makeFixture(t);

  const result = runScript(fixture);
  assert.equal(result.status, 0, result.stderr);

  const logLines = readLogLines(fixture);

  const createLines = logLines.filter((line) => line.startsWith("release create"));
  assert.equal(createLines.length, 1);
  assert.match(createLines[0], /--draft\b/);
  assert.match(createLines[0], /--prerelease\b/);
  assert.ok(
    createLines[0].includes(`OpenWhispr ${TAG_VERSION} (Soniox)`),
    "release title uses the tag's version, suffix included"
  );

  assert.ok(
    result.stdout.includes(`Renaming '${EXE_NAME_ON_DISK}' to '${EXE_NAME_UPLOADED}'`),
    "renames the spaced NSIS exe before uploading"
  );

  const uploadLines = logLines.filter((line) => line.startsWith("release upload"));
  assert.equal(uploadLines.length, UPLOADED_NAMES.length + 1, "the deb upload retries once");
  for (const name of UPLOADED_NAMES) {
    const count = uploadLines.filter((line) => line.includes(name)).length;
    assert.equal(count, name === DEB_NAME ? 2 : 1, `${name} upload count`);
  }
  for (const line of uploadLines) {
    assert.match(line, /--clobber\b/);
  }

  const editLines = logLines.filter((line) => line.startsWith("release edit"));
  assert.equal(editLines.length, 1);
  assert.match(editLines[0], /--draft=false\b/);
  assert.match(editLines[0], /--prerelease\b/);
  assert.equal(logLines[logLines.length - 1], editLines[0], "notes edit runs last");

  const tokens = editLines[0].split(/\s+/);
  const notesPath = tokens[tokens.indexOf("--notes-file") + 1];
  const renderedNotes = fs.readFileSync(notesPath, "utf8");
  assert.ok(renderedNotes.includes(EXE_NAME_UPLOADED), "renders the dotted Windows installer name");
  assert.ok(renderedNotes.includes(GITHUB_SHA), "substitutes GITHUB_SHA");
  assert.ok(renderedNotes.includes("$USER"), "leaves the reader-facing $USER literal");
});

test("a rerun reuses the existing release: no create, every asset re-uploaded, notes edited", (t) => {
  const fixture = makeFixture(t);
  // The fake gh's view succeeds once its marker exists, i.e. the previous run
  // already created the (draft) release.
  fs.writeFileSync(path.join(fixture.stateDir, "view-called"), "");

  const result = runScript(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Reusing existing release/);

  const logLines = readLogLines(fixture);
  assert.equal(logLines.filter((line) => line.startsWith("release create")).length, 0);
  const uploadLines = logLines.filter((line) => line.startsWith("release upload"));
  assert.equal(uploadLines.length, FILE_NAMES.length + 1);
  // --clobber only replaces the previous run's exe if the local name is the
  // dotted one GitHub stored.
  assert.ok(uploadLines.some((line) => line.includes(EXE_NAME_UPLOADED)));
  assert.ok(!uploadLines.some((line) => line.includes(EXE_NAME_ON_DISK)));
  const editLines = logLines.filter((line) => line.startsWith("release edit"));
  assert.equal(editLines.length, 1);
  assert.match(editLines[0], /--draft=false\b/);
});

test("DRY_RUN prints the gh commands and never invokes the real gh", (t) => {
  const fixture = makeFixture(t);

  const result = runScript(fixture, { DRY_RUN: "1" });
  assert.equal(result.status, 0, result.stderr);

  const stdoutLines = result.stdout.split("\n").filter((line) => line.startsWith("DRY_RUN: gh "));
  const createLines = stdoutLines.filter((line) => line.includes("release create"));
  const uploadLines = stdoutLines.filter((line) => line.includes("release upload"));
  const editLines = stdoutLines.filter((line) => line.includes("release edit"));

  assert.equal(createLines.length, 1);
  assert.equal(uploadLines.length, UPLOADED_NAMES.length);
  // The rename is local work, not a gh call, so it still runs under DRY_RUN.
  for (const name of UPLOADED_NAMES) {
    assert.ok(
      uploadLines.some((line) => line.includes(name)),
      `${name} printed in a dry-run upload line`
    );
  }
  assert.equal(editLines.length, 1);

  assert.deepEqual(readLogLines(fixture), [], "the fake gh log stays untouched");
});

test("fails before any gh call when release/ does not hold exactly 5 files", (t) => {
  const fixture = makeFixture(t, { fileNames: FILE_NAMES.slice(0, 4) });

  const result = runScript(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Expected exactly 5 files/);
  assert.deepEqual(readLogLines(fixture), []);
});

test("fails before any gh call when the tag version does not start with the AppImage version", (t) => {
  // A real "wrong build's artifacts collected" case: 1.10.2-soniox.3 does not
  // start with 1.10.1, unlike the legitimate 1.10.2-soniox.3 vs. 1.10.2 case.
  const fixture = makeFixture(t, {
    appImageName: `OpenWhispr-1.10.1-linux-x86_64.AppImage`,
  });

  const result = runScript(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not start with/);
  assert.deepEqual(readLogLines(fixture), []);
});

test("--target and the notes' Built-from line use the passed-in GITHUB_SHA, not the dispatching commit", (t) => {
  const fixture = makeFixture(t);
  // A realistic-looking headSha, resolved by fork-prerelease.yml from the build
  // run and deliberately different from the module-level GITHUB_SHA constant
  // (which stands in for whatever commit merely dispatched the workflow).
  const BUILD_SHA = "9f1c2b3a4d5e6f708900aabbccddeeff11223344";

  const result = runScript(fixture, { GITHUB_SHA: BUILD_SHA });
  assert.equal(result.status, 0, result.stderr);

  const logLines = readLogLines(fixture);
  const createLines = logLines.filter((line) => line.startsWith("release create"));
  assert.equal(createLines.length, 1);
  assert.match(createLines[0], new RegExp(`--target ${BUILD_SHA}\\b`));

  const editLines = logLines.filter((line) => line.startsWith("release edit"));
  const tokens = editLines[0].split(/\s+/);
  const notesPath = tokens[tokens.indexOf("--notes-file") + 1];
  const renderedNotes = fs.readFileSync(notesPath, "utf8");
  assert.ok(
    renderedNotes.includes(`Built from \`${BUILD_SHA}\``),
    "notes credit the resolved build SHA, not the dispatching commit"
  );
});
