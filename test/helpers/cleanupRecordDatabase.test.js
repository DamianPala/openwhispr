const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createDb, skipOrFail } = require("./harness/db.js");
const { setUserDataDir } = require("./harness/electronStub.js");
const DatabaseManager = require("../../src/helpers/database.js");

const CLEANUP_COLUMNS = [
  "cleanup_status",
  "cleanup_provider",
  "cleanup_model",
  "cleanup_prompt_hash",
  "cleanup_ms",
  "cleanup_error",
];

const columnTypes = (db) =>
  Object.fromEntries(
    db.db
      .prepare("PRAGMA table_info(transcriptions)")
      .all()
      .map((column) => [column.name, column.type])
  );

const readRow = (db, id) => db.db.prepare("SELECT * FROM transcriptions WHERE id = ?").get(id);

test("a fresh database has the six cleanup columns", (t) => {
  const db = createDb(t);
  if (!db) return;

  const types = columnTypes(db);

  assert.deepEqual(
    CLEANUP_COLUMNS.map((name) => types[name]),
    ["TEXT", "TEXT", "TEXT", "TEXT", "INTEGER", "TEXT"]
  );
});

test("a database created before the columns exist is migrated and keeps its rows", (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-cleanup-record-db-"));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));

  let BetterSqlite;
  try {
    BetterSqlite = require("better-sqlite3");
    new BetterSqlite(":memory:").close();
  } catch (error) {
    skipOrFail(t, error);
    return;
  }

  // The table as it stood before this change: no cleanup_* columns.
  const legacy = new BetterSqlite(path.join(userDataDir, "transcriptions.db"));
  legacy.exec(`
    CREATE TABLE transcriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      raw_text TEXT,
      route_kind TEXT
    )
  `);
  legacy
    .prepare("INSERT INTO transcriptions (text, raw_text) VALUES (?, ?)")
    .run("Hello.", "hello");
  legacy.close();

  setUserDataDir(userDataDir);
  const db = new DatabaseManager();
  t.after(() => db.db.close());

  const types = columnTypes(db);
  for (const name of CLEANUP_COLUMNS) assert.ok(name in types, `${name} was not added`);
  const old = db.db.prepare("SELECT * FROM transcriptions WHERE raw_text = 'hello'").get();
  assert.equal(old.text, "Hello.");
  for (const name of CLEANUP_COLUMNS) assert.equal(old[name], null);

  // Opening the migrated database again must not trip over the existing columns.
  db.db.close();
  const reopened = new DatabaseManager();
  t.after(() => reopened.db.close());
  assert.ok("cleanup_status" in columnTypes(reopened));
});

test("saveTranscription stores the cleanup record in its six columns", (t) => {
  const db = createDb(t);
  if (!db) return;

  const { id, transcription } = db.saveTranscription("Hello.", "hello", {
    cleanupRecord: {
      status: "ok",
      provider: "custom",
      model: "google/gemini-3.5-flash-lite",
      promptHash: "0123456789ab",
      ms: 412,
      error: null,
    },
  });

  const row = readRow(db, id);
  assert.equal(row.cleanup_status, "ok");
  assert.equal(row.cleanup_provider, "custom");
  assert.equal(row.cleanup_model, "google/gemini-3.5-flash-lite");
  assert.equal(row.cleanup_prompt_hash, "0123456789ab");
  assert.equal(row.cleanup_ms, 412);
  assert.equal(row.cleanup_error, null);
  assert.equal(transcription.cleanup_status, "ok");
  assert.equal(row.text, "Hello.");
  assert.equal(row.raw_text, "hello");
});

test("a failed cleanup keeps its error and a null prompt hash", (t) => {
  const db = createDb(t);
  if (!db) return;

  const { id } = db.saveTranscription("hello", "hello", {
    cleanupRecord: {
      status: "error",
      provider: "openwhispr",
      model: null,
      promptHash: null,
      ms: 30000,
      error: "Request timed out",
    },
  });

  const row = readRow(db, id);
  assert.equal(row.cleanup_status, "error");
  assert.equal(row.cleanup_provider, "openwhispr");
  assert.equal(row.cleanup_model, null);
  assert.equal(row.cleanup_prompt_hash, null);
  assert.equal(row.cleanup_ms, 30000);
  assert.equal(row.cleanup_error, "Request timed out");
});

test("saveTranscription without a cleanupRecord leaves all six columns null", (t) => {
  const db = createDb(t);
  if (!db) return;

  const plain = db.saveTranscription("Hello.", "hello");
  const withOtherOptions = db.saveTranscription("Ciao", "Hello", { routeKind: "translation" });

  for (const { id } of [plain, withOtherOptions]) {
    const row = readRow(db, id);
    for (const name of CLEANUP_COLUMNS) assert.equal(row[name], null, name);
  }
});
