#!/usr/bin/env node
/**
 * Ensures the Linux text monitor binary is available.
 *
 * Strategy:
 * 1. If binary exists and is up-to-date, do nothing
 * 2. Compile locally when the AT-SPI2 dev headers are present
 * 3. Fall back to the prebuilt binary from GitHub releases
 *
 * The download keeps builds working for developers without AT-SPI2 dev headers.
 */

const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const isLinux = process.platform === "linux";

const projectRoot = path.resolve(__dirname, "..");
const cSource = path.join(projectRoot, "resources", "linux-text-monitor.c");
const outputDir = path.join(projectRoot, "resources", "bin");
const outputBinary = path.join(outputDir, "linux-text-monitor");
const hashFile = path.join(outputDir, ".linux-text-monitor.hash");

// Written to the hash file instead of a source hash when the binary came
// from tryDownload(): a downloaded binary predates this checkout's source,
// so it is never "up to date" the way a matching hash means, only usable.
const DOWNLOADED_MARKER = "downloaded";

function log(message) {
  console.log(`[linux-text-monitor] ${message}`);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function computeSourceHash(sourcePath, pkgFlags) {
  const flagStr = pkgFlags ? pkgFlags.join(" ") : "";
  const sourceContent = fs.readFileSync(sourcePath, "utf8");
  return crypto
    .createHash("sha256")
    .update(sourceContent + flagStr)
    .digest("hex");
}

// True when hashFile pins the binary to source it no longer matches, or to a
// download that a now-available compiler should replace with a local build.
function isBinaryStale(sourcePath, hashPath, getFlags) {
  if (!fs.existsSync(hashPath)) {
    fs.writeFileSync(hashPath, computeSourceHash(sourcePath, getFlags()));
    return false;
  }

  const savedHash = fs.readFileSync(hashPath, "utf8").trim();
  if (savedHash === DOWNLOADED_MARKER) {
    if (getFlags()) {
      log("Downloaded binary is stale now that a compiler is available, rebuild needed");
      return true;
    }
    return false;
  }

  if (savedHash !== computeSourceHash(sourcePath, getFlags())) {
    log("Source or build flags changed, rebuild needed");
    return true;
  }

  return false;
}

function isBinaryUpToDate(
  binaryPath = outputBinary,
  sourcePath = cSource,
  hashPath = hashFile,
  getFlags = getPkgConfigFlags
) {
  if (!fs.existsSync(binaryPath)) {
    return false;
  }

  if (!fs.existsSync(sourcePath)) {
    return true;
  }

  try {
    const binaryStat = fs.statSync(binaryPath);
    const sourceStat = fs.statSync(sourcePath);
    if (binaryStat.mtimeMs < sourceStat.mtimeMs) {
      return false;
    }
  } catch {
    return false;
  }

  try {
    return !isBinaryStale(sourcePath, hashPath, getFlags);
  } catch (err) {
    log(`Hash check failed: ${err.message}, forcing rebuild`);
    return false;
  }
}

async function tryDownload() {
  log("Attempting to download prebuilt binary...");

  const downloadScript = path.join(__dirname, "download-text-monitor.js");
  if (!fs.existsSync(downloadScript)) {
    log("Download script not found, skipping download");
    return false;
  }

  const result = spawnSync(process.execPath, [downloadScript, "--force"], {
    stdio: "inherit",
    cwd: projectRoot,
  });

  if (result.status === 0 && fs.existsSync(outputBinary)) {
    log("Successfully downloaded prebuilt binary");
    try {
      fs.writeFileSync(hashFile, DOWNLOADED_MARKER);
    } catch (err) {
      log(`Warning: Could not save download marker: ${err.message}`);
    }
    return true;
  }

  log("Download failed or binary not found after download");
  return false;
}

function getPkgConfigFlags() {
  try {
    const check = spawnSync("pkg-config", ["--exists", "atspi-2"], {
      stdio: "pipe",
      env: process.env,
    });
    if (check.status !== 0) return null;

    const result = spawnSync("pkg-config", ["--cflags", "--libs", "atspi-2"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    if (result.status !== 0) return null;

    // atspi-2.pc lists gobject-2.0 under Requires.private, so plain --libs
    // omits -lgobject-2.0; add it explicitly for --as-needed linkers.
    return [...result.stdout.toString().trim().split(/\s+/).filter(Boolean), "-lgobject-2.0"];
  } catch {
    return null;
  }
}

function attemptCompile(command, args) {
  log(`Compiling with ${[command, ...args].join(" ")}`);
  return spawnSync(command, args, {
    stdio: "inherit",
    env: process.env,
  });
}

function tryCompile() {
  if (!fs.existsSync(cSource)) {
    log("C source not found, cannot compile locally");
    return false;
  }

  const pkgFlags = getPkgConfigFlags();
  if (!pkgFlags) {
    log("AT-SPI2 development headers not found, cannot compile locally");
    return false;
  }

  log("Attempting local compilation...");

  const compileArgs = ["-O2", cSource, "-o", outputBinary, ...pkgFlags];

  let result = attemptCompile("gcc", compileArgs);
  if (result.status !== 0) {
    result = attemptCompile("cc", compileArgs);
  }

  if (result.status !== 0) {
    return false;
  }

  try {
    fs.chmodSync(outputBinary, 0o755);
  } catch (error) {
    console.warn(`[linux-text-monitor] Unable to set executable permissions: ${error.message}`);
  }

  try {
    fs.writeFileSync(hashFile, computeSourceHash(cSource, pkgFlags));
  } catch (err) {
    log(`Warning: Could not save source hash: ${err.message}`);
  }

  log("Successfully built Linux text monitor binary");
  return true;
}

async function main() {
  ensureDir(outputDir);

  if (isBinaryUpToDate()) {
    log("Binary is up to date, skipping build");
    return;
  }

  // The prebuilt release lags this checkout's source; compile whenever the
  // toolchain is present so local fixes actually ship.
  const compiled = tryCompile();
  if (compiled) {
    return;
  }

  const downloaded = await tryDownload();
  if (downloaded) {
    return;
  }

  console.warn("[linux-text-monitor] Could not obtain Linux text monitor binary.");
  console.warn("[linux-text-monitor] Auto-learn correction monitoring will be disabled on Linux.");
  console.warn(
    "[linux-text-monitor] To compile locally, install libatspi2.0-dev and libglib2.0-dev. Falling back to Python script."
  );
}

if (require.main === module) {
  if (!isLinux) {
    process.exit(0);
  }
  main().catch((error) => {
    console.error("[linux-text-monitor] Unexpected error:", error);
  });
}

module.exports = { DOWNLOADED_MARKER, getPkgConfigFlags, isBinaryUpToDate };
