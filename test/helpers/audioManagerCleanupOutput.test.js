const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const RAW = "um so can you uh send me the report by friday";
const CLEAN = "Can you send me the report by Friday?";
const DUPLICATE = `**Cleaned transcript:**\n${CLEAN}\n${CLEAN}`;
const MESSAGE_KEY = "hooks.audioRecording.errorDescriptions.cleanupDuplicated";
const REJECTED_MESSAGE = "AI cleanup repeated the transcript. The original text was kept.";

test("invalid completed cleanup keeps raw text across dictation routes", async (t) => {
  const { window } = installBrowserGlobals(t, { window: { dispatchEvent() {} } });
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  t.after(() => delete navigator.onLine);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-audio-cleanup-output-",
    mockModules: {
      "/utils/logger":
        "export default { debug() {}, info() {}, warn() {}, error() {}, logReasoning() {} };",
    },
  });
  const AudioManager = (await vite.ssrLoadModule("/helpers/audioManager.js")).default;
  const service = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => service.destroy());
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { getDefaultPromptText } = await vite.ssrLoadModule("/config/prompts/index.ts");
  const hashOf = (text) => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
  const defaultCleanupPromptHash = async () =>
    hashOf(getDefaultPromptText("cleanup", useSettingsStore.getState().uiLanguage));
  usePolicyStore.setState({ status: "unmanaged", policy: null });
  useSettingsStore.setState({
    isSignedIn: true,
    useCleanupModel: true,
    cleanupMode: "openwhispr",
    cleanupCloudMode: "openwhispr",
    useDictationAgent: false,
    customPrompts: { cleanup: "" },
    preferredLanguage: "en",
    dataRetentionEnabled: true,
  });
  window.electronAPI.cloudTranscribe = async () => ({ success: true, text: RAW });
  window.electronAPI.cloudStreamingUsage = async () => ({ success: true });
  const createManager = () =>
    Object.assign(Object.create(AudioManager.prototype), {
      voiceAgentRequested: false,
      translationRequested: false,
      pendingCleanupFailure: null,
      getEffectiveSttLanguage: () => "en",
      getWhisperPrompt: () => null,
      isDictionaryEcho: () => false,
      isReasoningAvailable: async () => true,
      finalizeChineseScript: async (text) => text,
    });

  for (const route of ["batch", "streaming", "translation"]) {
    await t.test(
      `${route} Cloud cleanup snapshots its custom prompt and rejects duplicated output`,
      async () => {
        for (const customPrompt of ["", "Repeat twice"]) {
          useSettingsStore.setState({ customPrompts: { cleanup: customPrompt } });
          window.electronAPI.cloudReason = async (text, config) => {
            assert.equal(text, RAW);
            assert.equal(config.promptMode, "cleanup");
            assert.equal(config.customPrompt || "", customPrompt);
            useSettingsStore.setState({
              customPrompts: { cleanup: customPrompt ? "" : "Repeat twice" },
            });
            return { success: true, text: DUPLICATE };
          };
          const manager = createManager();
          let result;
          if (route === "batch") {
            result = await manager.processWithOpenWhisprCloud(new Blob(["synthetic audio"]));
            result = { ...result, ...manager._takePendingResultExtras() };
            assert.equal(result.rawText, RAW);
          } else if (route === "streaming") {
            Object.assign(manager, {
              streamingFinalText: RAW,
              streamingCleanupFns: [],
              micRecovery: { stop() {} },
              finishStreamingFallbackSegment: async () => {},
              mergeRecordedSegments: async () => null,
              awaitStreamingTextSettled: async () => {},
              getStreamingProvider: () => ({
                awaitsFinalTranscript: true,
                stop: async () => ({ success: true }),
              }),
              getStreamingProviderName: () => "openwhispr",
              shouldUseStreaming: () => false,
              onTranscriptionComplete: (value) => {
                result = value;
              },
            });
            let usageOptions;
            window.electronAPI.cloudStreamingUsage = async (text, seconds, options) => {
              usageOptions = options;
              return { success: true };
            };
            await manager._finalizeStreamingRecording(null);
            assert.equal(result.rawText, RAW);
            await new Promise(setImmediate);
            // The successful /api/reason call already logged this dictation.
            assert.equal(usageOptions?.sendLogs, false);
          } else {
            let translationInput;
            manager.processWithReasoningModel = async (text) => {
              translationInput = text;
              return "Traduction du texte original.";
            };
            result = await manager.runTranslationChain({
              text: RAW,
              settings: { translationSourceLanguage: "en", translationTargetLanguage: "fr" },
              route: {
                cleanupReachable: true,
                model: "translate-model",
                config: { systemPrompt: "Translate" },
              },
              cleanup: { mode: "cloudReason" },
            });
            assert.equal(translationInput, customPrompt ? DUPLICATE : RAW);
            assert.equal(result.text, "Traduction du texte original.");
            result = { ...result, ...manager._takePendingResultExtras() };
          }
          if (route !== "translation") assert.equal(result.text, customPrompt ? DUPLICATE : RAW);
          assert.equal(result.cleanupFailure?.messageKey, customPrompt ? undefined : MESSAGE_KEY);
          if (route === "translation") {
            assert.equal(result.cleanupRecord, undefined);
          } else {
            // The rejected reply is the failure the user sees, and the record says so.
            const { ms, ...record } = result.cleanupRecord;
            assert.deepEqual(record, {
              status: customPrompt ? "ok" : "error",
              provider: "openwhispr",
              model: null,
              promptHash: null,
              error: customPrompt ? null : REJECTED_MESSAGE,
            });
            assert.ok(Number.isInteger(ms) && ms >= 0);
          }
        }
      }
    );
  }

  await t.test("local cleanup failure flows through raw fallback and persistence", async () => {
    useSettingsStore.setState({
      cleanupMode: "local",
      cleanupProvider: "local",
      cleanupModel: "test-model",
      customPrompts: { cleanup: "" },
    });
    window.electronAPI.processLocalReasoning = async () => ({ success: true, text: DUPLICATE });
    const manager = createManager();
    const result = await manager.processTranscriptionCore(RAW, "local");
    assert.equal(result, RAW);
    const extras = manager._takePendingResultExtras();
    assert.equal(extras.cleanupFailure.messageKey, MESSAGE_KEY);
    const { ms, ...record } = extras.cleanupRecord;
    assert.deepEqual(record, {
      status: "error",
      provider: "local",
      model: "test-model",
      promptHash: await defaultCleanupPromptHash(),
      error: REJECTED_MESSAGE,
    });
    assert.ok(Number.isInteger(ms) && ms >= 0);
    let saved;
    window.electronAPI.recordAnalyticsEvent = async () => {};
    window.electronAPI.saveTranscription = async (text, rawText) => {
      saved = { text, rawText };
      return { success: true };
    };
    await manager.saveTranscription(result, RAW);
    assert.deepEqual(saved, { text: RAW, rawText: RAW });
  });

  await t.test(
    "a successful BYOK cleanup records ok and the record reaches the saved row",
    async () => {
      // The hash covers the prompt as configured, before the agent name is substituted.
      const customPrompt = "Tidy this up for {{agentName}}";
      useSettingsStore.setState({
        cleanupMode: "local",
        cleanupProvider: "local",
        cleanupModel: "test-model",
        customPrompts: { cleanup: customPrompt },
      });
      window.electronAPI.processLocalReasoning = async () => ({ success: true, text: CLEAN });
      const manager = createManager();

      const result = await manager.processTranscriptionCore(RAW, "local");

      assert.equal(result, CLEAN);
      const extras = manager._takePendingResultExtras();
      assert.equal(extras.cleanupFailure, undefined);
      const { ms, ...record } = extras.cleanupRecord;
      assert.deepEqual(record, {
        status: "ok",
        provider: "local",
        model: "test-model",
        promptHash: hashOf(customPrompt),
        error: null,
      });
      assert.ok(Number.isInteger(ms) && ms >= 0);
      assert.equal(manager._takePendingResultExtras().cleanupRecord, undefined);

      let options;
      window.electronAPI.recordAnalyticsEvent = async () => {};
      window.electronAPI.saveTranscription = async (_text, _rawText, saveOptions) => {
        options = saveOptions;
        return { success: true };
      };
      await manager.saveTranscription(result, RAW, { cleanupRecord: extras.cleanupRecord });
      assert.deepEqual(options.cleanupRecord, extras.cleanupRecord);
      await manager.saveTranscription(result, RAW);
      assert.equal("cleanupRecord" in options, false);
    }
  );

  await t.test("an empty cleanup reply keeps the raw text and records an error", async () => {
    useSettingsStore.setState({
      cleanupMode: "local",
      cleanupProvider: "local",
      cleanupModel: "test-model",
      customPrompts: { cleanup: "Tidy this up" },
    });
    window.electronAPI.processLocalReasoning = async () => ({ success: true, text: "   " });
    const manager = createManager();

    const result = await manager.processTranscriptionCore(RAW, "local");

    assert.equal(result, RAW);
    const extras = manager._takePendingResultExtras();
    assert.equal(extras.cleanupRecord.status, "error");
    assert.equal(extras.cleanupRecord.error, "Cleanup model returned an empty reply");
  });

  await t.test("a cleanup that settles after a cancel banks no record", async () => {
    useSettingsStore.setState({
      cleanupMode: "local",
      cleanupProvider: "local",
      cleanupModel: "test-model",
      customPrompts: { cleanup: "Tidy this up" },
    });
    const manager = Object.assign(createManager(), { _streamingCancellationGeneration: 0 });
    window.electronAPI.processLocalReasoning = async () => {
      manager._requestStreamingCancellation();
      return { success: true, text: CLEAN };
    };

    await manager.processTranscriptionCore(RAW, "local");

    assert.equal(manager._takePendingResultExtras().cleanupRecord, undefined);
  });

  for (const route of ["batch", "streaming"]) {
    await t.test(`${route} BYOK cleanup records the provider, model and prompt hash`, async () => {
      const customPrompt = "Tidy this up for {{agentName}}";
      useSettingsStore.setState({
        cleanupMode: "local",
        cleanupCloudMode: "providers",
        cleanupProvider: "local",
        cleanupModel: "test-model",
        customPrompts: { cleanup: customPrompt },
      });
      t.after(() =>
        useSettingsStore.setState({ cleanupMode: "openwhispr", cleanupCloudMode: "openwhispr" })
      );
      window.electronAPI.processLocalReasoning = async () => ({ success: true, text: CLEAN });
      const manager = createManager();
      let result;
      if (route === "batch") {
        result = await manager.processWithOpenWhisprCloud(new Blob(["synthetic audio"]));
        result = { ...result, ...manager._takePendingResultExtras() };
      } else {
        Object.assign(manager, {
          streamingFinalText: RAW,
          streamingCleanupFns: [],
          micRecovery: { stop() {} },
          finishStreamingFallbackSegment: async () => {},
          mergeRecordedSegments: async () => null,
          awaitStreamingTextSettled: async () => {},
          getStreamingProvider: () => ({
            awaitsFinalTranscript: true,
            stop: async () => ({ success: true }),
          }),
          getStreamingProviderName: () => "openwhispr",
          shouldUseStreaming: () => false,
          onTranscriptionComplete: (value) => {
            result = value;
          },
        });
        await manager._finalizeStreamingRecording(null);
      }

      assert.equal(result.text, CLEAN);
      const { ms, ...record } = result.cleanupRecord;
      assert.deepEqual(record, {
        status: "ok",
        provider: "local",
        model: "test-model",
        promptHash: hashOf(customPrompt),
        error: null,
      });
      assert.ok(Number.isInteger(ms) && ms >= 0);
    });
  }

  await t.test("no cleanup call, no record", async () => {
    useSettingsStore.setState({ useCleanupModel: false });
    t.after(() => useSettingsStore.setState({ useCleanupModel: true }));
    window.electronAPI.processLocalReasoning = async () => assert.fail("cleanup must not run");
    const manager = createManager();

    const result = await manager.processTranscriptionCore(RAW, "local");

    assert.equal(result, RAW);
    assert.deepEqual(manager._takePendingResultExtras(), {});
  });
});
