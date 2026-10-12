import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { DEV_CHATGPT_CONNECTOR_NAME, loadConfig } from "../src/config";
import { DevChatDriver, createLauncherDevAdapter } from "../src/dev-chat/driver";
import { DEV_CONFIG_PURPOSE, DEV_LAUNCHER_PROFILE } from "../src/dev-chat/constants";
import { DevChatStore } from "../src/dev-chat/session";
import { activateDevProfileEnvironment, resolveDevProfilePaths } from "../src/dev-chat/profile";
import { startDevChatTransport, type DevChatTransport } from "../src/dev-chat/transport";
import { inspectLauncherBrowserHost } from "../src/launcher-browser-host";

const MODEL = "chatgpt-web/gpt-6-sol" as const;
const paths = resolveDevProfilePaths();
activateDevProfileEnvironment(paths);
if (!existsSync(paths.configPath)) throw new Error("The isolated DEV harness is not configured");

const config = loadConfig();
if (config.purpose !== DEV_CONFIG_PURPOSE) throw new Error("Follow-up smoke requires the isolated DEV profile");
if (config.browserHost !== "launcher" || !config.browserHostDescriptorPath) {
  throw new Error("Follow-up smoke requires the running DEV Launcher browser host");
}
if (config.experimentalFreshConversationPerTurn) {
  throw new Error("Follow-up smoke requires retained conversations; fresh conversations per turn are enabled");
}
if (!config.solAvailable) throw new Error("GPT-6 Sol is unavailable in the current DEV account configuration");
if (config.mode === "full" && config.appName !== DEV_CHATGPT_CONNECTOR_NAME) {
  throw new Error("The DEV connector identity is outdated; refresh the DEV profile before testing");
}
await inspectLauncherBrowserHost(config.browserHostDescriptorPath, { expectedProfile: DEV_LAUNCHER_PROFILE });

let transport: DevChatTransport | undefined;
let driver: DevChatDriver | undefined;
try {
  transport = config.mode === "full" ? await startDevChatTransport(config, paths.runtimePath) : undefined;
  const runtimeConfig = transport?.config ?? config;
  const runtime = createLauncherDevAdapter(runtimeConfig, paths.runtimePath, {
    ...(transport ? { broker: transport.broker } : {}),
  });
  driver = new DevChatDriver(
    runtimeConfig,
    new DevChatStore(paths.chatsPath),
    runtime.adapterFactory,
    process.cwd(),
    { biggerContext: runtimeConfig.experimentalBiggerContext === true },
  );

  const suffix = randomBytes(5).toString("hex");
  const chatName = `followup-smoke-${Date.now().toString(36)}-${suffix}`;
  const marker = `FUP-${randomBytes(4).toString("hex").toUpperCase()}`;
  const { state, created } = driver.open(chatName, MODEL);
  if (!created) throw new Error("Follow-up smoke chat name unexpectedly already exists");

  const firstStartedAt = performance.now();
  const first = await driver.send(
    state,
    `Remember this exact marker for my next message: ${marker}. Reply with only the marker.`,
  );
  const firstTurnMs = Math.round(performance.now() - firstStartedAt);
  if (first.text.trim() !== marker) throw new Error("GPT-6 Sol did not echo the first-turn marker exactly");

  const followupStartedAt = performance.now();
  const followup = await driver.send(
    state,
    "In this same conversation, reply with only the exact marker I asked you to remember.",
  );
  const followupTurnMs = Math.round(performance.now() - followupStartedAt);
  if (followup.text.trim() !== marker) {
    throw new Error(`GPT-6 Sol follow-up did not recall the marker; received ${JSON.stringify(followup.text.trim())}`);
  }

  console.log(JSON.stringify({
    ok: true,
    model: MODEL,
    chat_name: chatName,
    first_turn_ms: firstTurnMs,
    followup_turn_ms: followupTurnMs,
    marker,
    followup_answer: followup.text.trim(),
    usage: followup.usage,
  }));
} finally {
  const cleanup = await Promise.allSettled([
    driver?.close() ?? Promise.resolve(),
    transport?.close() ?? Promise.resolve(),
  ]);
  const failures = cleanup.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length > 0) {
    throw new AggregateError(failures.map(result => result.reason), "Follow-up smoke cleanup failed");
  }
}
