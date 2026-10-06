import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { estimateTokens } from "../src/lib/token-estimate";
import type { CodexParsedRequest } from "../src/types";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const baseline = process.argv[2] ?? "20296a5ac3b8327c6660e3607b992f91ee0c37c0";
const root = resolve(import.meta.dir, "..");
const directory = join(root, "output", "backend-performance-2026-10-06");
mkdirSync(directory, { recursive: true });
const entry = join(directory, "policy-entry.ts");
await Bun.write(entry, `export { compileChatGptWebPrompt } from '../../src/adapters/chatgpt-web/prompt';\nexport { CHATGPT_NATIVE_MCP_INSTRUCTIONS } from '../../src/adapters/chatgpt-web/mcp-server';\nimport { runChatGptMcpServer } from '../../src/adapters/chatgpt-web/mcp-server';\nif (process.argv.includes('--server')) await runChatGptMcpServer({brokerSocketPath:'benchmark-unused'});`);
const parsed: CodexParsedRequest = { modelId: "gpt-5.6-sol", stream: true, options: { reasoning: "high" },
  context: { systemPrompt: ["Preserve native instruction priority."], messages: [{ role: "user", content: "Verify marker POLICY_OK", timestamp: 0 }] } };
for (const mode of ["baseline", "current"] as const) {
  const built = await Bun.build({ entrypoints: [entry], target: "bun", format: "esm", packages: "external",
    plugins: mode === "baseline" ? [{ name: "canonical-baseline", setup(build) {
      build.onLoad({ filter: /[\\/]adapters[\\/]chatgpt-web[\\/](?:prompt|mcp-server)\.ts$/ }, args => {
        const path = args.path.slice(root.length + 1).replaceAll("\\", "/");
        const result = Bun.spawnSync(["git", "show", `${baseline}:${path}`], { cwd: root });
        if (result.exitCode) throw new Error(result.stderr.toString());
        return { contents: result.stdout.toString(), loader: "ts" };
      });
    } }] : [] });
  if (!built.success) throw new AggregateError(built.logs, "Policy benchmark build failed");
  const output = join(directory, `${mode}-policy.mjs`);
  await Bun.write(output, await built.outputs[0]!.text());
  const module = await import(output);
  const compiled = module.compileChatGptWebPrompt(parsed, { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true }, "benchmark_capability_0000000000000000");
  const client = new Client({ name: "policy-benchmark", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["run", output, "--server"], stderr: "pipe" }));
  let toolCount: number, schemaTokens: number;
  try {
    const list = await client.listTools(); toolCount = list.tools.length; schemaTokens = estimateTokens(JSON.stringify(list.tools));
  } finally { await client.close(); }
  console.log(JSON.stringify({ mode, workload: "sol-high-native-policy", baseline, tool_count: toolCount, tool_schema_tokens: schemaTokens,
    transport_tokens: estimateTokens(compiled.text), mcp_instructions_tokens: estimateTokens(module.CHATGPT_NATIVE_MCP_INSTRUCTIONS),
    measured: true, model_latency_measured: false }));
}
