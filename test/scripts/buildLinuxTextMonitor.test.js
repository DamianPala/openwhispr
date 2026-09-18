const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { DOWNLOADED_MARKER, isBinaryUpToDate } = require("../../scripts/build-linux-text-monitor");

const HEADERS_PRESENT = ["-I/usr/include/at-spi-2.0", "-latspi"];
const withHeaders = () => HEADERS_PRESENT;
const withoutHeaders = () => null;

function sourceHash(sourceContent, pkgFlags) {
  return crypto
    .createHash("sha256")
    .update(sourceContent + pkgFlags.join(" "))
    .digest("hex");
}

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-build-text-monitor-"));
  const binaryPath = path.join(dir, "linux-text-monitor");
  const sourcePath = path.join(dir, "linux-text-monitor.c");
  const hashPath = path.join(dir, ".linux-text-monitor.hash");
  fs.writeFileSync(sourcePath, "int main(void) { return 0; }\n");
  fs.writeFileSync(binaryPath, "compiled binary");
  return { dir, binaryPath, sourcePath, hashPath };
}

test("isBinaryUpToDate: no binary is always stale", () => {
  const { dir, binaryPath, sourcePath, hashPath } = makeFixture();
  try {
    fs.rmSync(binaryPath);
    assert.equal(isBinaryUpToDate(binaryPath, sourcePath, hashPath, withHeaders), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("isBinaryUpToDate: binary with no hash file self-certifies and writes one", () => {
  const { dir, binaryPath, sourcePath, hashPath } = makeFixture();
  try {
    assert.ok(!fs.existsSync(hashPath));
    assert.equal(isBinaryUpToDate(binaryPath, sourcePath, hashPath, withHeaders), true);
    assert.ok(fs.existsSync(hashPath), "expected the first run to write a hash file");
    assert.equal(
      fs.readFileSync(hashPath, "utf8"),
      sourceHash(fs.readFileSync(sourcePath, "utf8"), HEADERS_PRESENT)
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("isBinaryUpToDate: matching source+flags hash is up to date", () => {
  const { dir, binaryPath, sourcePath, hashPath } = makeFixture();
  try {
    fs.writeFileSync(hashPath, sourceHash(fs.readFileSync(sourcePath, "utf8"), HEADERS_PRESENT));
    assert.equal(isBinaryUpToDate(binaryPath, sourcePath, hashPath, withHeaders), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("isBinaryUpToDate: a source or flag change invalidates the saved hash", () => {
  const { dir, binaryPath, sourcePath, hashPath } = makeFixture();
  try {
    fs.writeFileSync(hashPath, sourceHash("different source", HEADERS_PRESENT));
    assert.equal(isBinaryUpToDate(binaryPath, sourcePath, hashPath, withHeaders), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// N3: a downloaded binary predates this checkout's source and self-certified
// forever once the old code wrote a source hash for it on the first run.
// The marker instead makes it stale the moment a compiler becomes available,
// so a dev machine that gains the AT-SPI2 headers rebuilds from source.
test("isBinaryUpToDate: a downloaded marker is stale once a compiler is available", () => {
  const { dir, binaryPath, sourcePath, hashPath } = makeFixture();
  try {
    fs.writeFileSync(hashPath, DOWNLOADED_MARKER);
    assert.equal(isBinaryUpToDate(binaryPath, sourcePath, hashPath, withHeaders), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("isBinaryUpToDate: a downloaded marker stays up to date without a compiler", () => {
  const { dir, binaryPath, sourcePath, hashPath } = makeFixture();
  try {
    fs.writeFileSync(hashPath, DOWNLOADED_MARKER);
    assert.equal(isBinaryUpToDate(binaryPath, sourcePath, hashPath, withoutHeaders), true);
    assert.equal(
      fs.readFileSync(hashPath, "utf8"),
      DOWNLOADED_MARKER,
      "the marker itself is untouched"
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("isBinaryUpToDate: no source file trusts whatever binary is on disk", () => {
  const { dir, binaryPath, sourcePath, hashPath } = makeFixture();
  try {
    fs.rmSync(sourcePath);
    assert.equal(isBinaryUpToDate(binaryPath, sourcePath, hashPath, withHeaders), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
