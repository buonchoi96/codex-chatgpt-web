const languages = require("./languages.json");
const fs = require("node:fs");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const SIDEBAR_MIN_WIDTH = 240;
const SIDEBAR_MAX_WIDTH = 420;
const SESSION_REFRESH_REMINDER_INTERVAL_MS = 48 * 60 * 60 * 1000;
const AUTOMATION_SECURITY_SIGNALS = new Set([
  "cloudflare_challenge",
  "security_challenge",
  "account_security_warning",
  "reauthentication_loop",
  "invalid_security_state",
]);

function createDefaultAutomationSecurity() {
  return {
    version: 1,
    paused: false,
    revision: 0,
    signal: null,
    detectedAt: null,
    resumedAt: null,
  };
}

const DEFAULT_STATE = Object.freeze({
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
  automationSecurity: Object.freeze(createDefaultAutomationSecurity()),
});

function isValidIsoTimestamp(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return false;
  return new Date(value).toISOString() === value;
}

function normalizeAutomationSecurity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.version !== 1
    || typeof value.paused !== "boolean"
    || !Number.isSafeInteger(value.revision)
    || value.revision < 0
    || (value.signal !== null && !AUTOMATION_SECURITY_SIGNALS.has(value.signal))) {
    return null;
  }

  if (value.signal === null) {
    if (value.paused || value.revision !== 0 || value.detectedAt !== null || value.resumedAt !== null) return null;
  } else {
    if (value.revision === 0 || !isValidIsoTimestamp(value.detectedAt)) return null;
    if (value.paused ? value.resumedAt !== null : !isValidIsoTimestamp(value.resumedAt)) return null;
  }

  return {
    version: 1,
    paused: value.paused,
    revision: value.revision,
    signal: value.signal,
    detectedAt: value.detectedAt,
    resumedAt: value.resumedAt,
  };
}

function createInvalidAutomationSecurity(value) {
  const previousRevision = value && Number.isSafeInteger(value.revision) && value.revision >= 0
    ? value.revision
    : 0;
  const revision = previousRevision < Number.MAX_SAFE_INTEGER ? previousRevision + 1 : 1;
  return {
    version: 1,
    paused: true,
    revision,
    signal: "invalid_security_state",
    detectedAt: new Date().toISOString(),
    resumedAt: null,
  };
}

function createDefaultState(automationSecurity = createDefaultAutomationSecurity()) {
  return { ...DEFAULT_STATE, automationSecurity };
}

function nextSessionRefreshReminderAt(now = Date.now()) {
  if (!Number.isFinite(now)) throw new Error("Session refresh reminder time must be finite");
  return new Date(now + SESSION_REFRESH_REMINDER_INTERVAL_MS).toISOString();
}

function readState(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return createDefaultState();
    return createDefaultState(createInvalidAutomationSecurity());
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.version !== 1) {
    return createDefaultState(createInvalidAutomationSecurity(parsed?.automationSecurity));
  }

  const state = { ...DEFAULT_STATE, ...parsed };
  state.automationSecurity = Object.hasOwn(parsed, "automationSecurity")
    ? normalizeAutomationSecurity(parsed.automationSecurity)
      ?? createInvalidAutomationSecurity(parsed.automationSecurity)
    : createDefaultAutomationSecurity();
  delete state.bridgeEnabled;
  if (state.language !== null && (typeof state.language !== "string" || !Object.hasOwn(languages, state.language))) {
    state.language = DEFAULT_STATE.language;
  }
  for (const key of [
    "onboardingComplete",
    "githubOpened",
    "xOpened",
    "autoStart",
    "keepRunningOnClose",
    "showBrowserDuringTurns",
    "experimentalBiggerContext",
    "experimentalSkillAttachments",
    "experimentalFreshConversationPerTurn",
    "useSavedChats",
    "zeroRiskProEnabled",
    "browserSmokePassed",
    "sidebarOpen",
  ]) {
    if (typeof state[key] !== "boolean") state[key] = DEFAULT_STATE[key];
  }
  if (state.browserInteractionMode !== "automatic" && state.browserInteractionMode !== "manual") {
    state.browserInteractionMode = DEFAULT_STATE.browserInteractionMode;
  }
  if (state.coreSetupComplete !== true) {
    if (state.onboardingComplete !== true) state.browserInteractionMode = "automatic";
    state.zeroRiskProEnabled = false;
  }
  if (state.browserSmokeVersion !== null
    && (typeof state.browserSmokeVersion !== "string" || state.browserSmokeVersion.length > 128)) {
    state.browserSmokeVersion = DEFAULT_STATE.browserSmokeVersion;
  }
  if (!Number.isFinite(state.sidebarWidth)
    || state.sidebarWidth < SIDEBAR_MIN_WIDTH
    || state.sidebarWidth > SIDEBAR_MAX_WIDTH) {
    state.sidebarWidth = DEFAULT_STATE.sidebarWidth;
  }
  if (!Number.isInteger(state.mcpGuideStep) || state.mcpGuideStep < 0 || state.mcpGuideStep > 2) {
    state.mcpGuideStep = DEFAULT_STATE.mcpGuideStep;
  }
  if (state.sessionRefreshReminderAt !== null
    && (typeof state.sessionRefreshReminderAt !== "string"
      || !Number.isFinite(Date.parse(state.sessionRefreshReminderAt)))) {
    state.sessionRefreshReminderAt = DEFAULT_STATE.sessionRefreshReminderAt;
  }
  for (const key of [
    "coreSetupComplete",
    "codexCatalogVerified",
    "mcpSetupComplete",
    "mcpRuntimeInstalled",
    "codexRestartRequired",
  ]) {
    if (state[key] !== undefined && typeof state[key] !== "boolean") delete state[key];
  }
  return state;
}

function writeState(filePath, state) {
  writePrivateFileAtomic(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

function validateSidebarState(value) {
  if (!value || typeof value !== "object" || typeof value.open !== "boolean") {
    throw new Error("Sidebar state is invalid");
  }
  if (!Number.isFinite(value.width) || value.width < SIDEBAR_MIN_WIDTH || value.width > SIDEBAR_MAX_WIDTH) {
    throw new Error(`Sidebar width must be between ${SIDEBAR_MIN_WIDTH} and ${SIDEBAR_MAX_WIDTH}`);
  }
  return { sidebarOpen: value.open, sidebarWidth: Math.round(value.width) };
}

function createStateStore(filePath) {
  let state = readState(filePath);
  function persist(next) {
    writeState(filePath, next);
    state = next;
    return structuredClone(next);
  }

  function nextSecurityRevision() {
    const revision = state.automationSecurity.revision + 1;
    if (!Number.isSafeInteger(revision)) throw new Error("Automation security revision is exhausted");
    return revision;
  }

  return {
    read() {
      return structuredClone(state);
    },
    update(patch) {
      const safePatch = { ...(patch ?? {}) };
      delete safePatch.automationSecurity;
      return persist({ ...state, ...safePatch, automationSecurity: state.automationSecurity, version: 1 });
    },
    pauseAutomationSecurity(signal, at = new Date().toISOString()) {
      if (!AUTOMATION_SECURITY_SIGNALS.has(signal) || signal === "invalid_security_state") {
        throw new Error("Automation security signal is invalid");
      }
      if (!isValidIsoTimestamp(at)) throw new Error("Automation security timestamp is invalid");
      if (state.automationSecurity.paused) return structuredClone(state);
      return persist({
        ...state,
        automationSecurity: {
          version: 1,
          paused: true,
          revision: nextSecurityRevision(),
          signal,
          detectedAt: at,
          resumedAt: null,
        },
      });
    },
    resumeAutomationSecurity(at = new Date().toISOString()) {
      if (!isValidIsoTimestamp(at)) throw new Error("Automation security timestamp is invalid");
      if (!state.automationSecurity.paused) return structuredClone(state);
      return persist({
        ...state,
        automationSecurity: {
          ...state.automationSecurity,
          paused: false,
          revision: nextSecurityRevision(),
          resumedAt: at,
        },
      });
    },
  };
}

module.exports = {
  SESSION_REFRESH_REMINDER_INTERVAL_MS,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  createStateStore,
  nextSessionRefreshReminderAt,
  validateSidebarState,
};
