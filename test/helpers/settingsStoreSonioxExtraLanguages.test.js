const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// The single Secondary Language dropdown became a list of up to 3 extra
// languages (slice 6). A prior selection becomes the array's sole entry, and
// the retired key must not resurface on a hand-edited localStorage.
test("sonioxSecondaryLanguage migrates to sonioxExtraLanguages", async (t) => {
  const { storage } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-soniox-extra-languages-migration-test-",
  });

  const load = async () => {
    vite.moduleGraph.invalidateAll();
    return vite.ssrLoadModule("/stores/settingsStore.ts");
  };

  await t.test("a non-empty legacy value becomes the sole array entry", async () => {
    storage.clear();
    storage.setItem("sonioxSecondaryLanguage", "de");

    const { useSettingsStore } = await load();

    assert.deepEqual(useSettingsStore.getState().sonioxExtraLanguages, ["de"]);
    assert.equal(storage.getItem("sonioxSecondaryLanguage"), null, "the old key is removed");
  });

  await t.test("an empty legacy value is dropped without creating an array", async () => {
    storage.clear();
    storage.setItem("sonioxSecondaryLanguage", "");

    const { useSettingsStore } = await load();

    assert.deepEqual(useSettingsStore.getState().sonioxExtraLanguages, []);
    assert.equal(storage.getItem("sonioxSecondaryLanguage"), null);
  });

  await t.test("an already-migrated array is left alone", async () => {
    storage.clear();
    storage.setItem("sonioxExtraLanguages", JSON.stringify(["fr"]));
    storage.setItem("sonioxSecondaryLanguage", "de");

    const { useSettingsStore } = await load();

    assert.deepEqual(useSettingsStore.getState().sonioxExtraLanguages, ["fr"]);
    assert.equal(storage.getItem("sonioxSecondaryLanguage"), null);
  });

  await t.test("no legacy key is a no-op", async () => {
    storage.clear();

    const { useSettingsStore } = await load();

    assert.deepEqual(useSettingsStore.getState().sonioxExtraLanguages, []);
  });
});

test("setSonioxExtraLanguages dedupes, drops the main language, and caps at 3", async (t) => {
  const { storage } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-soniox-extra-languages-setter-test-",
  });

  storage.clear();
  storage.setItem("preferredLanguage", "en");
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");

  useSettingsStore.getState().setSonioxExtraLanguages(["pl", "pl", "en", "de", "fr", "it"]);

  const { sonioxExtraLanguages } = useSettingsStore.getState();
  assert.deepEqual(
    sonioxExtraLanguages,
    ["pl", "de", "fr"],
    "duplicates and the main language are dropped, then the list is capped at 3"
  );
  assert.deepEqual(
    JSON.parse(storage.getItem("sonioxExtraLanguages")),
    ["pl", "de", "fr"],
    "persisted the same way it's read back"
  );
});
