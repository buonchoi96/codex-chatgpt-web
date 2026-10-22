import {readFileSync,writeFileSync} from "node:fs";

function edit(path, from, to) {
  const text = readFileSync(path, "utf8");
  const count = text.split(from).length - 1;
  if (count !== 1) throw new Error(`Merge reconciliation expected one occurrence in ${path}, found ${count}: ${from.slice(0,90)}`);
  writeFileSync(path, text.replace(from,to));
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
edit(root+"prompt.ts",
  '  const manualControl = options?.manualControl === true;\n  const attachSkills = options?.experimentalSkillAttachments === true;',
  '  const manualControl = options?.manualControl === true;\n  const appName = options?.appName?.trim() || (manualControl ? ZERO_RISK_CHATGPT_CONNECTOR_NAME : CHATGPT_CONNECTOR_NAME);\n  const attachSkills = options?.experimentalSkillAttachments === true;'
);
console.log("Reconciled upstream v6.1.13 TypeScript integrations");
