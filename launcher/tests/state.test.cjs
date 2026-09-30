const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  SESSION_REFRESH_REMINDER_INTERVAL_MS,
  createStateStore,
  nextSessionRefreshReminderAt,
  validateSidebarState,
} = require("../electron/state.cjs");

test("launcher state persists onboarding, language, and autostart atomically", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-launcher-state-"));
  const file = path.join(root, "state.json");
  try {
    const store = createStateStore(file);
    assert.deepEqual(store.read(), {
      version: 1,
      language: null,
      onboardingComplete: false,
      githubOpened: false,
      xOpened: false,
      autoStart: true,
      keepRunningOnClose: true,
      showBrowserDuringTurns: true,
      browserInteractionMode: "automatic",
      experimentalBiggerContext: false,
      autoCompactPercent: 26,
      experimentalSkillAttachments: false,
      experimentalFreshConversationPerTurn: false,
      useSavedChats: false,
      zeroRiskProEnabled: false,
      browserSmokePassed: false,
      browserSmokeVersion: null,
      sidebarOpen: true,
      sidebarWidth: 252,
      mcpGuideStep: 0,
      sessionRefreshReminderAt: null,
      automationSecurity: {
        version: 1,
        paused: false,
        revision: 0,
        signal: null,
        detectedAt: null,
        resumedAt: null,
      },
    });
    store.update({
      language: "zh-CN",
      onboardingComplete: true,
      keepRunningOnClose: false,
      browserSmokePassed: true,
      browserSmokeVersion: "0.2.0",
    });
    assert.deepEqual(createStateStore(file).read(), {
      version: 1,
      language: "zh-CN",
      onboardingComplete: true,
      githubOpened: false,
      xOpened: false,
      autoStart: true,
      keepRunningOnClose: false,
      showBrowserDuringTurns: true,
      browserInteractionMode: "automatic",
      experimentalBiggerContext: false,
      autoCompactPercent: 26,
      experimentalSkillAttachments: false,
      experimentalFreshConversationPerTurn: false,
      useSavedChats: false,
      zeroRiskProEnabled: false,
      browserSmokePassed: true,
      browserSmokeVersion: "0.2.0",
      sidebarOpen: true,
      sidebarWidth: 252,
      mcpGuideStep: 0,
      sessionRefreshReminderAt: null,
      automationSecurity: {
        version: 1,
        paused: false,
        revision: 0,
        signal: null,
        detectedAt: null,
        resumedAt: null,
      },
    });
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o077, 0);
    assert.equal(fs.readdirSync(root).some(name => name.includes(".tmp-")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sidebar state accepts only bounded native shell dimensions", () => {
  assert.deepEqual(validateSidebarState({ open: false, width: 300.4 }), {
    sidebarOpen: false,
    sidebarWidth: 300,
  });
  assert.throws(() => validateSidebarState({ open: "yes", width: 300 }), /invalid/);
  assert.throws(() => validateSidebarState({ open: true, width: 100 }), /between 240 and 420/);
  assert.throws(() => validateSidebarState({ open: true, width: 900 }), /between 240 and 420/);
});

test("every supported launcher language survives a state update and reload", () => {
  const languages = require("../electron/languages.json");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-locale-state-"));
  const file = path.join(root, "state.json");
  try {
    for (const language of Object.keys(languages)) {
      const store = createStateStore(file);
      store.update({ language, onboardingComplete: true });
      assert.equal(createStateStore(file).read().language, language);
      assert.equal(createStateStore(file).read().onboardingComplete, true);
    }
    for (const language of ["__proto__", "constructor", "unknown", [], {}]) {
      fs.writeFileSync(file, JSON.stringify({ version: 1, language, onboardingComplete: true }));
      const state = createStateStore(file).read();
      assert.equal(state.language, null);
      assert.equal(state.onboardingComplete, true);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("persisted sidebar corruption is repaired without changing the rest of launcher state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-sidebar-state-"));
  const file = path.join(root, "state.json");
  try {
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      language: "zh-CN",
      onboardingComplete: "yes",
      autoStart: "yes",
      experimentalFreshConversationPerTurn: "true",
      autoCompactPercent: 101,
      bridgeEnabled: false,
      browserSmokePassed: "yes",
      browserSmokeVersion: { invalid: true },
      sidebarOpen: "yes",
      sidebarWidth: 900,
      mcpGuideStep: 99,
      sessionRefreshReminderAt: "not-a-date",
      coreSetupComplete: "yes",
    }));
    assert.deepEqual(createStateStore(file).read(), {
      version: 1,
      language: "zh-CN",
      onboardingComplete: false,
      githubOpened: false,
      xOpened: false,
      autoStart: true,
      keepRunningOnClose: true,
      showBrowserDuringTurns: true,
      browserInteractionMode: "automatic",
      experimentalBiggerContext: false,
      autoCompactPercent: 26,
      experimentalSkillAttachments: false,
      experimentalFreshConversationPerTurn: false,
      useSavedChats: false,
      zeroRiskProEnabled: false,
      browserSmokePassed: false,
      browserSmokeVersion: null,
      sidebarOpen: true,
      sidebarWidth: 252,
      mcpGuideStep: 0,
      sessionRefreshReminderAt: null,
      automationSecurity: {
        version: 1,
        paused: false,
        revision: 0,
        signal: null,
        detectedAt: null,
        resumedAt: null,
      },
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("browser interaction defaults to Automatic and preserves a completed onboarding choice", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-interaction-state-"));
  const file = path.join(root, "state.json");
  try {
    const store = createStateStore(file);
    assert.equal(store.read().browserInteractionMode, "automatic");
    store.update({ browserInteractionMode: "manual", onboardingComplete: true });
    assert.equal(createStateStore(file).read().browserInteractionMode, "manual");
    assert.equal(createStateStore(file).read().zeroRiskProEnabled, false);
    store.update({ coreSetupComplete: true, zeroRiskProEnabled: true, experimentalFreshConversationPerTurn: true });
    assert.equal(createStateStore(file).read().zeroRiskProEnabled, true);
    assert.equal(createStateStore(file).read().experimentalFreshConversationPerTurn, true);
    store.update({ browserInteractionMode: "automatic" });
    assert.equal(createStateStore(file).read().experimentalFreshConversationPerTurn, true);
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      browserInteractionMode: "manual",
      zeroRiskProEnabled: true,
    }));
    assert.equal(createStateStore(file).read().browserInteractionMode, "automatic");
    assert.equal(createStateStore(file).read().zeroRiskProEnabled, false);
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      onboardingComplete: true,
      browserInteractionMode: "manual",
    }));
    assert.equal(createStateStore(file).read().browserInteractionMode, "manual");
    fs.writeFileSync(file, JSON.stringify({ version: 1, browserInteractionMode: "unsafe" }));
    assert.equal(createStateStore(file).read().browserInteractionMode, "automatic");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("session refresh reminders are deferred by exactly 48 hours", () => {
  const now = Date.UTC(2026, 7, 5, 12, 0, 0);
  assert.equal(SESSION_REFRESH_REMINDER_INTERVAL_MS, 48 * 60 * 60 * 1000);
  assert.equal(nextSessionRefreshReminderAt(now), "2026-08-07T12:00:00.000Z");
  assert.throws(() => nextSessionRefreshReminderAt(Number.NaN), /must be finite/);
});

test("legacy launcher state migrates to an unpaused automation-security record", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-legacy-security-state-"));
  const file = path.join(root, "state.json");
  try {
    fs.writeFileSync(file, JSON.stringify({ version: 1, language: "zh-CN", onboardingComplete: true }));
    const state = createStateStore(file).read();
    assert.equal(state.language, "zh-CN");
    assert.deepEqual(state.automationSecurity, {
      version: 1,
      paused: false,
      revision: 0,
      signal: null,
      detectedAt: null,
      resumedAt: null,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("automation-security pause and explicit resume persist increasing revisions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-security-transition-"));
  const file = path.join(root, "state.json");
  try {
    const store = createStateStore(file);
    const paused = store.pauseAutomationSecurity("cloudflare_challenge", "2026-09-29T06:00:00.000Z");
    assert.deepEqual(paused.automationSecurity, {
      version: 1,
      paused: true,
      revision: 1,
      signal: "cloudflare_challenge",
      detectedAt: "2026-09-29T06:00:00.000Z",
      resumedAt: null,
    });
    assert.equal(createStateStore(file).read().automationSecurity.revision, 1);

    const resumed = store.resumeAutomationSecurity("2026-09-29T06:05:00.000Z");
    assert.deepEqual(resumed.automationSecurity, {
      version: 1,
      paused: false,
      revision: 2,
      signal: "cloudflare_challenge",
      detectedAt: "2026-09-29T06:00:00.000Z",
      resumedAt: "2026-09-29T06:05:00.000Z",
    });
    assert.deepEqual(createStateStore(file).read().automationSecurity, resumed.automationSecurity);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("automation-security transitions reject unknown signals and invalid timestamps", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-security-validation-"));
  const file = path.join(root, "state.json");
  try {
    const store = createStateStore(file);
    assert.throws(() => store.pauseAutomationSecurity("unknown", "2026-09-29T06:00:00.000Z"), /signal/i);
    assert.throws(() => store.pauseAutomationSecurity("security_challenge", "yesterday"), /timestamp/i);
    assert.throws(() => store.resumeAutomationSecurity("not-a-date"), /timestamp/i);
    assert.equal(store.read().automationSecurity.revision, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("malformed persisted automation-security state fails closed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-security-corruption-"));
  const file = path.join(root, "state.json");
  try {
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      automationSecurity: {
        version: 1,
        paused: false,
        revision: -1,
        signal: "unrecognized",
        detectedAt: "not-a-date",
        resumedAt: null,
      },
    }));
    const state = createStateStore(file).read().automationSecurity;
    assert.equal(state.version, 1);
    assert.equal(state.paused, true);
    assert.equal(state.revision, 1);
    assert.equal(state.signal, "invalid_security_state");
    assert.ok(Number.isFinite(Date.parse(state.detectedAt)));
    assert.equal(state.resumedAt, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a missing state file defaults open but corrupt state-file bytes fail closed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-corrupt-launcher-state-"));
  const file = path.join(root, "state.json");
  try {
    assert.equal(createStateStore(file).read().automationSecurity.paused, false);
    fs.writeFileSync(file, "{broken json");
    const state = createStateStore(file).read();
    assert.equal(state.automationSecurity.paused, true);
    assert.equal(state.automationSecurity.signal, "invalid_security_state");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("generic launcher updates cannot clear the automation-security latch", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-security-update-"));
  const file = path.join(root, "state.json");
  try {
    const store = createStateStore(file);
    store.pauseAutomationSecurity("account_security_warning", "2026-09-29T06:00:00.000Z");
    store.update({ automationSecurity: {
      version: 1,
      paused: false,
      revision: 2,
      signal: null,
      detectedAt: null,
      resumedAt: null,
    } });
    assert.equal(store.read().automationSecurity.paused, true);
    assert.equal(store.read().automationSecurity.revision, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
