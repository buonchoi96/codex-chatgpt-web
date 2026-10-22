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


{
  const file=root+"codex-rollout-environment.ts";
  let content=readFileSync(file,"utf8");
  if(!content.includes("function renderFilesystemProfile(")){
    const anchor="export function resolveCurrentCodexRolloutEnvironment(";
    if(!content.includes(anchor)) throw Error("Native rollout function not found");
    content=content.replace(anchor,"function renderFilesystemProfile(value: unknown, roots: string[]): string | undefined {\n  const profile = record(value);\n  if (profile?.type === \"disabled\") {\n    return '<permission_profile type=\"disabled\"><file_system type=\"unrestricted\" /></permission_profile>';\n  }\n  const fs = record(profile?.file_system);\n  if (profile?.type !== \"managed\" || fs?.type !== \"restricted\" || !Array.isArray(fs.entries)) return undefined;\n  const entries: Record<string, unknown>[] = [];\n  for (const raw of fs.entries) {\n    const entry = record(raw);\n    const path = record(entry?.path);\n    if (!entry || !path) return undefined;\n    const special = path.type === \"special\" ? record(path.value) : undefined;\n    const expanded = special?.kind === \"project_roots\"\n      ? roots.map(root => ({ ...entry, path: { type: \"path\", path: typeof special.subpath === \"string\" ? join(root, special.subpath) : root } }))\n      : [entry];\n    for (const candidate of expanded) {\n      if (!entries.some(prior => isDeepStrictEqual(prior, candidate))) entries.push(candidate);\n    }\n  }\n  const xml = (text: string): string => text.replace(/[&<>\"']/g, char => ({\n    \"&\": \"&amp;\", \"<\": \"&lt;\", \">\": \"&gt;\", '\"': \"&quot;\", \"'\": \"&apos;\",\n  })[char]!);\n  const rendered: string[] = [];\n  for (const entry of entries) {\n    const path = record(entry.path)!;\n    let tag: string;\n    let text: unknown;\n    if (path.type === \"path\") { tag = \"path\"; text = path.path; }\n    else if (path.type === \"glob_pattern\") { tag = \"glob\"; text = path.pattern; }\n    else if (path.type === \"special\") {\n      tag = \"special\";\n      const special = record(path.value);\n      if (!special || ![\"root\", \"minimal\", \"tmpdir\", \"slash_tmp\"].includes(String(special.kind))) return undefined;\n      text = `:${special.kind}`;\n    } else return undefined;\n    if (typeof text !== \"string\") return undefined;\n    rendered.push(`<entry access=\"${entry.access}\"${entry.access === \"deny\" ? ' escalatable=\"false\"' : \"\"}><${tag}>${xml(text)}</${tag}></entry>`);\n  }\n  const depth = fs.glob_scan_max_depth === undefined ? \"\" : ` glob_scan_max_depth=\"${fs.glob_scan_max_depth}\"`;\n  return `<permission_profile type=\"managed\"><file_system type=\"restricted\"${depth}>${rendered.join(\"\")}</file_system></permission_profile>`;\n}\n\n"+anchor);
  }
  content=content.replace("  workspaceRootsDeclared: boolean;\n}","  workspaceRootsDeclared: boolean;\n  filesystemProfileXml?: string;\n}");
  const oldFn="return inspectCurrentCodexRollout(options,({environment,workspaceRootsDeclared})=>({environment,workspaceRootsDeclared}));";
  const newFn="return inspectCurrentCodexRollout(options,({turn,environment,workspaceRootsDeclared})=>({environment,workspaceRootsDeclared,filesystemProfileXml:renderFilesystemProfile(turn.permission_profile,environment.roots)}));";
  if(!content.includes(newFn)){
    if(!content.includes(oldFn))throw Error("Native rollout return shape unexpectedly changed");
    content=content.replace(oldFn,newFn);
  }
  writeFileSync(file,content);
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
optionalEdit(root+"prompt.ts",
  '      "For local work required by the task, use the attached Codex Native tools directly according to their declared descriptions and schemas.",',
  '      "For local work required by the task, use the selected plugin\'s tools directly according to their declared descriptions and schemas.",'
);
console.log("Reconciled upstream v6.1.13 TypeScript integrations");
