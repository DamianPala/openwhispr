const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const path = require("node:path");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

const noop = () => {};

// Real t() would translate; here it echoes the key so markup assertions can
// pin exact strings, and appends the interpolation object for calls that pass
// one (dictationTranslation.removeTarget) so the two remove buttons' labels
// differ and still carry the language name. src/i18n.ts does
// `i18n.use(initReactI18next).init(...)` as a side effect of importing the
// settings store, so the mock also needs a stand-in i18next plugin shape or
// that call throws ("undefined module").
const T_MOCK = `export function useTranslation() {
  return {
    t(key, opts) {
      return opts ? key + JSON.stringify(opts) : key;
    },
  };
}
export const initReactI18next = { type: "3rdParty", init() {} };`;

async function renderer(t, { initialStorage } = {}) {
  installBrowserGlobals(t, {
    initialStorage,
    window: {
      location: { search: "" },
      electronAPI: {
        getPlatform: () => "linux",
        onWhisperDownloadProgress: () => noop,
        onParakeetDownloadProgress: () => noop,
      },
    },
  });
  return createRendererServer(t, {
    cachePrefix: "openwhispr-soniox-provider-settings-",
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
    // react-i18next is a CJS dep Vite externalizes by default in SSR dev mode,
    // which resolves it via Node before this plugin's mockModules ever sees
    // the import — noExternal routes it back through the Vite graph so the
    // mock actually applies.
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": T_MOCK,
    },
  });
}

function sonioxPickerProps(overrides = {}) {
  return {
    transcriptionContext: "dictation",
    selectedCloudProvider: "soniox",
    onCloudProviderSelect: noop,
    selectedCloudModel: "stt-rt-v5",
    onCloudModelSelect: noop,
    selectedLocalModel: "",
    onLocalModelSelect: noop,
    useLocalWhisper: false,
    onModeChange: noop,
    ...overrides,
  };
}

async function render(vite, element) {
  const { ToastProvider } = await vite.ssrLoadModule("/components/ui/Toast.tsx");
  return renderToStaticMarkup(React.createElement(ToastProvider, null, element));
}

// The extra-languages row sits between its own label and the removeFillers
// block that follows it; slicing on those markers keeps disabled/hint
// assertions scoped to this row instead of the whole picker's markup.
function extraLanguagesSection(markup) {
  const start = markup.indexOf(">transcription.soniox.extraLanguages<");
  const end = markup.indexOf(">transcription.soniox.removeFillers.label<", start);
  assert.ok(start !== -1 && end !== -1, "extra-languages section not found in markup");
  return markup.slice(start, end);
}

test("chip remove buttons get distinct accessible names, flags are hidden from a11y tree", async (t) => {
  const vite = await renderer(t, {
    initialStorage: {
      preferredLanguage: "en",
      sonioxExtraLanguages: JSON.stringify(["de", "fr"]),
    },
  });
  const { default: Picker } = await vite.ssrLoadModule("/components/TranscriptionModelPicker.tsx");
  const markup = await render(vite, React.createElement(Picker, sonioxPickerProps()));
  const section = extraLanguagesSection(markup);

  const removeLabels = [
    ...section.matchAll(/aria-label="([^"]*dictationTranslation\.removeTarget[^"]*)"/g),
  ].map((m) => m[1]);
  assert.equal(removeLabels.length, 2);
  assert.notEqual(removeLabels[0], removeLabels[1]);
  assert.match(
    removeLabels.find((l) => l.includes("German")) ?? "",
    /dictationTranslation\.removeTarget/
  );
  assert.match(
    removeLabels.find((l) => l.includes("French")) ?? "",
    /dictationTranslation\.removeTarget/
  );

  const hiddenFlagCount = (section.match(/<span aria-hidden="true"/g) || []).length;
  assert.equal(hiddenFlagCount, 2);
});

test("auto language disables the row and shows the hint; a picked language does not", async (t) => {
  const autoVite = await renderer(t, {
    initialStorage: {
      preferredLanguage: "auto",
      sonioxExtraLanguages: JSON.stringify(["de", "fr"]),
    },
  });
  const { default: AutoPicker } = await autoVite.ssrLoadModule(
    "/components/TranscriptionModelPicker.tsx"
  );
  const autoMarkup = await render(autoVite, React.createElement(AutoPicker, sonioxPickerProps()));
  const autoSection = extraLanguagesSection(autoMarkup);
  assert.equal((autoSection.match(/ disabled=""/g) || []).length, 3);
  assert.match(autoSection, />transcription\.soniox\.extraLanguagesAutoHint</);

  const enVite = await renderer(t, {
    initialStorage: {
      preferredLanguage: "en",
      sonioxExtraLanguages: JSON.stringify(["de", "fr"]),
    },
  });
  const { default: EnPicker } = await enVite.ssrLoadModule(
    "/components/TranscriptionModelPicker.tsx"
  );
  const enMarkup = await render(enVite, React.createElement(EnPicker, sonioxPickerProps()));
  const enSection = extraLanguagesSection(enMarkup);
  assert.equal((enSection.match(/ disabled=""/g) || []).length, 0);
  assert.doesNotMatch(enSection, /extraLanguagesAutoHint/);
});

test("closing the extra-language picker returns focus to the Add button", async (t) => {
  const vite = await renderer(t, {
    initialStorage: {
      preferredLanguage: "en",
      sonioxExtraLanguages: JSON.stringify(["de", "fr"]),
    },
  });
  const container = installHookDom(t);
  const { default: Picker } = await vite.ssrLoadModule("/components/TranscriptionModelPicker.tsx");
  const { ToastContext } = await vite.ssrLoadModule("/components/ui/useToast.ts");

  let tree;
  function Harness() {
    tree = Picker(sonioxPickerProps());
    return null;
  }

  function elementContainsText(node, text) {
    if (node === text) return true;
    if (Array.isArray(node)) return node.some((child) => elementContainsText(child, text));
    if (node && typeof node === "object") return elementContainsText(node.props?.children, text);
    return false;
  }

  function findElement(node, predicate) {
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = findElement(child, predicate);
        if (found) return found;
      }
      return null;
    }
    if (!node || typeof node !== "object") return null;
    if (predicate(node)) return node;
    return findElement(node.props?.children, predicate);
  }

  const findAddButton = () =>
    findElement(
      tree,
      (n) => n.type === "button" && elementContainsText(n, "transcription.soniox.extraLanguagesAdd")
    );

  const root = createRoot(container);
  try {
    await React.act(async () => {
      root.render(
        React.createElement(
          ToastContext.Provider,
          { value: { toast: noop } },
          React.createElement(Harness)
        )
      );
    });

    const addButton = findAddButton();
    assert.ok(addButton, "add button not found");

    await React.act(async () => {
      addButton.props.onClick();
    });

    const selector = findElement(tree, (n) => n.type?.name === "LanguageSelector");
    assert.ok(selector, "LanguageSelector not found after opening the picker");

    let capturedCallback;
    const originalRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (cb) => {
      capturedCallback = cb;
      return 1;
    };
    try {
      await React.act(async () => {
        selector.props.onClose();
      });
    } finally {
      globalThis.requestAnimationFrame = originalRaf;
    }

    assert.ok(capturedCallback, "onClose did not schedule a requestAnimationFrame callback");

    const reopenedAddButton = findAddButton();
    assert.ok(reopenedAddButton, "add button not found after onClose");
    const ref = reopenedAddButton.props.ref;
    assert.ok(ref, "add button has no ref");

    let focusCalls = 0;
    ref.current = { focus: () => focusCalls++ };

    // Focus dropped to <body> when the picker unmounted (Escape, selection,
    // trigger click): the Add button takes it. The hook-DOM stub has no body,
    // so give it one; installHookDom discards the whole stub afterwards.
    const hookDocument = globalThis.document;
    hookDocument.body = { tagName: "BODY" };
    hookDocument.activeElement = null;
    capturedCallback();
    assert.equal(focusCalls, 1);
    hookDocument.activeElement = hookDocument.body;
    capturedCallback();
    assert.equal(focusCalls, 2);

    // A click-outside already focused the clicked control: leave it there.
    hookDocument.activeElement = { tagName: "SELECT" };
    capturedCallback();
    assert.equal(focusCalls, 2);
  } finally {
    await React.act(async () => root.unmount());
  }
});

test("keep-alive description stays a one-liner under 110 chars and keeps the option cost figures", () => {
  const en = require("../../src/locales/en/translation.json");
  const description = en.transcription.soniox.keepAlive.description;
  assert.equal(description.includes("\n"), false);
  assert.ok(description.length <= 110, `expected <=110 chars, got ${description.length}`);

  const options = en.transcription.soniox.keepAlive.options;
  assert.match(options["30"], /%/);
  assert.match(options["60"], /%/);
  assert.match(options["120"], /%/);
  assert.match(options["300"], /%/);
});
