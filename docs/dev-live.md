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
├── runtime/           # launcher ownership + browser descriptor
├── tunnel/            # tunnel profile/runtime state from normal Full Harness setup
└── ...
```

This is separate from both the installed launcher's data and the simulated
`~/.codex-chatgpt-web-dev` harness. The source launcher keeps production semantics: the real
Codex route, normal `Codex Native2` connector, and real tunnel. Set
`CODEX_WEB_GPT_LIVE_HOME` to choose another persistent home.

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
   setup once. The live home retains login, tunnel ID/runtime key configuration, and launcher state.
5. Restart Codex once after the initial route/catalog installation if requested.

Later `bun run dev:live` runs reuse that state. The script reconnects the live Codex route when
configuration is present. On normal Ctrl-C/SIGTERM it disconnects the live route to restore the
previous journaled Codex route.

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
