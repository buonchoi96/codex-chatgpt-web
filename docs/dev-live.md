# Live source development

`dev:live` is the fast production-like loop for the Windows launcher and real Codex integration.
It runs Electron and the Responses runtime from the current working tree while keeping browser and
runtime state in a durable live home. Ordinary source edits therefore do not require a GitHub
Actions build, installer download, reinstall, ChatGPT sign-in, or MCP reconfiguration.

## Persistent state

The default home is `~/.codex-chatgpt-web-live`:

```text
~/.codex-chatgpt-web-live/
├── config.json
├── launcher/          # Electron userData, ChatGPT cookies/local storage, window state
├── runtime/           # Desktop-lane launcher ownership + browser descriptor
├── tunnel/            # Desktop-lane tunnel profile/runtime state
├── cli-lane/          # dev:live-only Codex CLI route/runtime/tunnel state
└── ...
```

This is separate from both the installed launcher's data and the simulated
`~/.codex-chatgpt-web-dev` harness. The source launcher keeps production semantics for the
**Desktop lane**: the real Codex route, normal `Codex Native2` connector, and a real tunnel.
In `dev:live` only, an optional **CLI lane** lives under `cli-lane/` and uses its own Codex
home, Responses port, broker endpoint, connector name, tunnel alias/profile, and Tunnel ID.
Both lanes reuse the same authenticated launcher browser host, but their MCP/data planes remain
independent. Set `CODEX_WEB_GPT_LIVE_HOME` to choose another persistent Desktop home.

## First run

1. Quit the installed **Codex Web GPT** launcher. The live source launcher must exclusively own the
   active `Codex Native2` connector/tunnel.
2. Install locked dependencies once:

   ```powershell
   bun install --frozen-lockfile
   bun install --cwd launcher --frozen-lockfile
   ```

3. Start:

   ```powershell
   bun run dev:live
   ```

4. In the source launcher, sign in to the same ChatGPT account and complete normal Full Harness
   setup once. This is the **Desktop lane** and keeps using `Codex Native2`.
5. For concurrent Codex Desktop + Codex CLI testing, create a **second OpenAI Tunnel ID** and keep
   `dev:live` running, then execute:

   ```powershell
   bun run dev:live:cli-setup
   ```

   Enter the second Tunnel ID/runtime key when prompted. Then create a ChatGPT connector named
   exactly **`Codex Native2 CLI DEV`** and attach it to that second tunnel. Rerunning
   `dev:live:cli-setup` while `dev:live` remains open is supported: the wrapper drains and pauses
   the existing CLI daemon/tunnel before rebinding its port, then the supervisor resumes it after
   setup commits. Existing account capability results are reused on reruns unless
   `CODEX_WEB_GPT_LIVE_CLI_REFRESH_ACCOUNT_CAPABILITIES=1` is explicitly set.
6. Run test CLI processes through the isolated lane:

   ```powershell
   bun run dev:codex -- <normal codex arguments>
   ```

   Do not use a plain inherited `codex` process for dual-lane tests; the wrapper pins the CLI
   process to `cli-lane/codex-home`.

   For a session/exec without an explicit `-m/--model` or `--profile`, the wrapper defaults to
   `chatgpt-web/gpt-5.6-sol` (or `chatgpt-web/gpt-5.6-luna` when the CLI lane account does not
   expose Sol). It also supplies the route-compatible reasoning effort when
   `model_reasoning_effort` was not explicitly overridden: Sol defaults to `high`, Sol Instant
   and Luna to `low`, and fixed Pro routes to their fixed effort. Set
   `CODEX_WEB_GPT_LIVE_CLI_MODEL` / `CODEX_WEB_GPT_LIVE_CLI_EFFORT` to choose different DEV
   defaults. On Windows the wrapper also adds `--no-daemon` for TUI/resume/fork so Codex 0.157.x
   cannot fail on Job Object daemon detachment; `exec` remains on its normal one-shot path.
7. Restart the Desktop Codex app once after its initial route/catalog installation if requested.

Later `bun run dev:live` runs reuse both lane states. The script reconnects the Desktop Codex
route when configuration is present and supervises the CLI daemon/tunnel separately. On normal
Ctrl-C/SIGTERM it disconnects the Desktop live route, restores the previous Desktop route, and
stops the isolated CLI daemon/tunnel.

## Reload behavior

- `launcher/src/**`: Vite HMR; no ChatGPT restart.
- `src/**/*.ts`: rebuild the browser helper, drain the Responses daemon until no HTTP/browser turn
  is active, shut down only that daemon, and let the launcher supervisor restart it from the current
  working tree. Electron, authenticated ChatGPT WebContents, and tunnel remain alive.
- `launcher/electron/**`: restart source Electron because Electron-main code cannot be hot-swapped.
  The same persistent live userData is reused.

A runtime reload never intentionally cancels an active Codex task. It waits for
`active_http_turns` and `active_browser_turns` to reach zero. Default wait is 60 seconds; override
with `CODEX_WEB_GPT_LIVE_RESTART_TIMEOUT_MS`.

Typical bridge iteration:

```text
edit src/adapters/chatgpt-web/browser-worker.ts
        ↓
browser helper rebuild
        ↓
daemon drains (usually already idle)
        ↓
daemon restarts from source
        ↓
retry prompt in Codex
```

GitHub Actions, packaged smoke, and the installer remain the final release gate rather than the
ordinary development loop.

## dev:live vs dev:chat

- `dev:chat`: isolated DEV harness, no real Codex route, simulated tool side effects.
- `dev:live`: isolated persistent state but production semantics, real Codex route and real
  Native2/tunnel.

Do not run the installed launcher and `dev:live` at the same time with the same tunnel/connector.


## Dual Desktop / CLI tunnels in `dev:live`

Production behavior is unchanged: the packaged launcher continues to expose the existing shared
production tunnel behavior to normal Codex Desktop/CLI clients.

The dual-lane topology exists only under `bun run dev:live`:

```text
Codex Desktop/controller
  -> Desktop CODEX_HOME
  -> Desktop Responses daemon
  -> Desktop broker
  -> Codex Native2
  -> Desktop Tunnel ID

bun run dev:codex -- ...
  -> cli-lane/codex-home
  -> CLI Responses daemon
  -> CLI broker
  -> Codex Native2 CLI DEV
  -> different CLI Tunnel ID
```

The CLI lane refuses to start when it shares the Desktop lane's Tunnel ID, tunnel alias/profile,
Responses port, broker endpoint, control token, or connector name. Electron-main reloads are also
deferred while the CLI lane has an active HTTP/browser turn, so a source-launcher reload cannot
silently tear down an in-flight CLI test.

Useful overrides:

- `CODEX_WEB_GPT_LIVE_CLI_HOME`: CLI lane state directory.
- `CODEX_WEB_GPT_LIVE_CLI_CODEX_HOME`: isolated Codex home used by `dev:codex`.
- `CODEX_WEB_GPT_LIVE_CLI_PORT`: CLI Responses port used during first setup.
- `CODEX_WEB_GPT_LIVE_CLI_TUNNEL_ID`: optional non-interactive second Tunnel ID.
- `CODEX_WEB_GPT_LIVE_CLI_RUNTIME_KEY_FILE`: optional non-interactive runtime-key file.
- `CODEX_WEB_GPT_CODEX_BIN`: explicit Codex CLI executable for the wrapper.
- `CODEX_WEB_GPT_LIVE_CLI_MODEL`: default routed Web model for `dev:codex` sessions when no
  `-m/--model` or `--profile` is supplied.
- `CODEX_WEB_GPT_LIVE_CLI_EFFORT`: default reasoning effort injected for the selected routed Web
  model when no explicit `model_reasoning_effort` override or profile is supplied.

A Tunnel runtime key may have access to both tunnels, but the **Tunnel IDs themselves must differ**.
