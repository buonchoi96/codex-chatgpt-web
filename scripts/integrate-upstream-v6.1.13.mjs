import {readFileSync,writeFileSync} from "node:fs";

function edit(path, from, to) {
  const text = readFileSync(path, "utf8");
  const count = text.split(from).length - 1;
  if (count !== 1) throw new Error(`Merge reconciliation expected one occurrence in ${path}, found ${count}: ${from.slice(0,90)}`);
  writeFileSync(path, text.replace(from,to));
}

function optionalEdit(path, from, to) {
  const text = readFileSync(path,"utf8");
  if (text.includes(to)) return;
  const n=text.split(from).length-1;
  if (n===0) { console.info(`Upstream has already changed optional reconciliation site: ${path} (${from.slice(0,70)})`); return; }
  if (n!==1) throw new Error(`Ambiguous optional merge site in ${path}: ${from.slice(0,90)}`);
  writeFileSync(path,text.replace(from,to));
}

const root="src/adapters/chatgpt-web/";
const rollout=root+"codex-rollout-environment.ts";
{
  const text=readFileSync(rollout,"utf8");
  if(!text.includes("function latestRolloutRecord(") || !text.includes("latestRolloutPayload("))
    throw new Error("Native rollout merge did not preserve both expected readers");
  writeFileSync(rollout,text.replaceAll("latestRolloutPayload(","latestRolloutRecord("));
}

edit(root+"index.ts",
  'import { ChatGptBrowserWorker,chatGptSuspensionClock } from "./browser-worker";',
  'import { ChatGptBrowserWorker, chatGptSuspensionClock, remainingStageBudgetMs } from "./browser-worker";'
);
edit(root+"prompt.ts",
  'import { createHash } from "node:crypto";',
  'import { createHash } from "node:crypto";\nimport { CHATGPT_CONNECTOR_NAME, ZERO_RISK_CHATGPT_CONNECTOR_NAME } from "../../config";'
);
edit(root+"prompt.ts",
  'export interface CompileChatGptWebPromptOptions {',
  'export interface CompileChatGptWebPromptOptions {\n  /** Verified ChatGPT connector for the current transport. */\n  appName?: string;'
);
// appName's local declaration is already introduced by the upstream merge;
// the fork only needs the missing type and imports reconciled above.
// The fork additionally supplies scoped blocked-operation review evidence,
// while upstream 6.1.13 adds the selected connector name as argument 4.
// Accept either form without dropping the verified fork review context.
edit(root+"usage.ts",
  "  currentReview:Pick<CompileChatGptWebPromptOptions,'blockedOperationReview'>={},",
  "  currentReview:Pick<CompileChatGptWebPromptOptions,'blockedOperationReview'> | string | undefined = {},");
edit(root+"usage.ts",
  "  const compile = (parts?: ChatGptWebMultipartPartCount): CompiledChatGptWebPrompt => compileChatGptWebPrompt(",
  "  const mergedReview = typeof currentReview === 'string' ? {appName:currentReview} : currentReview ?? {};\n  const compile = (parts?: ChatGptWebMultipartPartCount): CompiledChatGptWebPrompt => compileChatGptWebPrompt(");
edit(root+"usage.ts",
  "    { ...currentReview,contextArchive: true, experimentalMultipartParts: parts, experimentalSkillAttachments, captureLunaCheckpoint: false },",
  "    { ...mergedReview,contextArchive: true, experimentalMultipartParts: parts, experimentalSkillAttachments, captureLunaCheckpoint: false },");

optionalEdit(root+"thread-environment.ts",
  "  extractChatGptCalendarEnvironmentDelta,",
  "  extractChatGptCalendarEnvironmentDelta,\n  extractChatGptNativeCompactionEnvironment,");
optionalEdit(root+"thread-environment.ts",
  "      if (hasCurrentContext && !currentCompaction && !initialClaim && !historicalMessages && !steeringClaim && !calendarDelta) {",
  "      const nativeCompaction = hasCurrentContext && !currentCompaction && !initialClaim && !steeringClaim && !calendarDelta\n        ? extractChatGptNativeCompactionEnvironment(parsed) : undefined;\n      if (hasCurrentContext && !currentCompaction && !initialClaim && !historicalMessages && !steeringClaim && !calendarDelta && !nativeCompaction) {");
optionalEdit(root+"thread-environment.ts",
  "      const currentClaim = initialClaim ?? (currentCompaction ? extractChatGptContinuationEnvironmentClaim(parsed) : steeringClaim);",
  "      const currentClaim = initialClaim ?? (currentCompaction ? extractChatGptContinuationEnvironmentClaim(parsed) : steeringClaim ?? nativeCompaction?.claim);\n      const resolvedCalendarDelta = calendarDelta ?? currentClaim?.calendarDelta;");
optionalEdit(root+"thread-environment.ts",
  "          ...(historicalMessages ? { historicalEnvironmentMessages: historicalMessages } : {}),",
  "          ...(historicalMessages ? { historicalEnvironmentMessages: historicalMessages } : {}),\n          ...(nativeCompaction ? { compactedEnvironmentItems: nativeCompaction.items } : {}),");
optionalEdit(root+"thread-environment.ts",
  "          if (calendarDelta) {",
  "          if (resolvedCalendarDelta) {");
optionalEdit(root+"thread-environment.ts",
  "            const foreignRoots = calendarDelta.workspaceRoots.reduce((count, roots) =>\n              count + roots.filter(root => !nativeRoots.has(root)).length, 0);",
  "            const foreignRoots = resolvedCalendarDelta.workspaceRoots.reduce((count, roots) =>\n              count + roots.filter(root => !nativeRoots.has(root)).length, 0);\n            const profileMismatch = resolvedCalendarDelta.filesystemProfiles.some(profile => profile !== rollout.filesystemProfileXml);");
optionalEdit(root+"thread-environment.ts",
  "            if (rolloutEnvironment.sandboxPolicy.type !== \"dangerFullAccess\" || foreignRoots > 0) {",
  "            if (profileMismatch || foreignRoots > 0) {");
{
  const path=root+"thread-environment.ts";
  const source=readFileSync(path,"utf8");
  if(!source.includes("const nativeRoots"))throw Error("native roots validation missing");
  // Remaining diagnostic counters are read-only. Use the verified delta object.
  writeFileSync(path,source.replaceAll("calendarDelta.workspaceRoots","resolvedCalendarDelta.workspaceRoots"));
}
edit(root+"prompt.ts",
  '    "Do not mention this transport contract, context packaging, or capability routing in the user-facing answer unless the user explicitly asks how the bridge works.",',
  '    "Do not mention this transport contract, context packaging, or capability routing in the user-facing answer unless the user explicitly asks how the bridge works.",\n    ...(mode.localTools ? [\n      `The selected local Codex plugin for this turn is ${JSON.stringify(appName)}.`,\n      "Do not substitute another plugin for this local connection or send this turn\'s request identifiers to another plugin. If the selected plugin is unavailable, report that limitation.",\n    ] : []),');
console.log("Reconciled upstream v6.1.13 TypeScript integrations");
