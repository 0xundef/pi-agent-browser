# Pi Agent Browser

AI agent-driven browser automation using `@mariozechner/pi-agent-core` with Playwright and MetaMask extension support.

## Prerequisites

| Requirement | Version / Notes |
|---|---|
| Node.js | >= 20.0.0 |
| npm | (bundled with Node) |
| macOS | arm64 (other platforms may need extra config) |

## Quick Start

```bash
# 1. Install Node dependencies
npm install

# 2. Install Playwright browser binaries (Chrome for Testing)
npx playwright install chromium

# 3. Configure your AI provider
cp .env.example .env
# Edit `.env` or `.env.local` (ANTHROPIC_AUTH_TOKEN / OPENAI_API_KEY, PI_PROVIDER, PI_MODEL, optional ANTHROPIC_BASE_URL).
# Or use JSON: config/pi-agent.config.json — or export vars in the shell (dotenv does not override existing env).
# Deploy: API keys in GitHub **Secrets**; set **Variables** e.g. PI_PROVIDER=anthropic, PI_MODEL=…, ANTHROPIC_BASE_URL=… (see `.github/workflows/ci.yml`). If PI_PROVIDER is unset, only Anthropic keys → provider anthropic.
npm run dev
```

## Project Structure

| Path | Purpose |
|---|---|
| `index.ts` | Main entry: HTTP control plane + AI test executor |
| `$AGENT_QUEUE_ROOT/status.json` | Run state written by the agent (OArmour syncs this into Postgres) |
| `.env` (from `.env.example`) | AI provider credentials and model (`PI_*`, `ANTHROPIC_*`, `OPENAI_*`); loaded via `dotenv` |
| `config/pi-agent.config.json` | Optional JSON provider config (same shape as before); use `PI_CONFIG` to point elsewhere |
| `$EXTENSION_STORAGE_ROOT/chrome-extension-analyzer/<extensionId>/<version>/` | Unpacked extension exact version directory |
| `$AGENT_QUEUE_ROOT/extension-data/<extensionId>/prompt.md` | Optional **per-extension** prompt (overrides global) |
| `$AGENT_QUEUE_ROOT/prompt.md` | **Default prompt** for all extensions; OArmour seeds this from its bundled template on enqueue; locally, `resources/default-extension-test-prompt.md` is copied here if missing |
| `$AGENT_QUEUE_ROOT/extension-data/<extensionId>/<version>/cli_config.json` | Runtime config; **auto-created** if missing (`chromium`, `headless` default true, `userDataDir` defaults to `<sidecar>/.playwright-profile`, `--no-sandbox` / `--disable-setuid-sandbox`, `--load-extension` points at unpacked extension under `chrome-extension-analyzer`) |
| `$AGENT_QUEUE_ROOT/extension-data/<extensionId>/<version>/ai_testing/<runId>/` | Agent execution artifacts (`recordings.json` and screenshots) |
| `scripts/enqueue-task.ts` | Local dev helper: `POST /v1/sessions` to a running agent |

### Queue and Status Fields

- OArmour Postgres `BrowserAgentTask` — dispatch queue (not stored on the agent disk).
- `$AGENT_QUEUE_ROOT/status.json`
  - `status_time`: last status update time in ISO 8601 format
  - `duration`: elapsed seconds from `incoming_time` to current status update
  - `runId`: stable output folder name under `ai_testing/<runId>/`

---

## Processing Flow (HTTP dispatch + Playwright CLI)

`npm run dev` starts a long-running **stateless executor** with an HTTP control plane (default port `8791`). OArmour owns the task queue in Postgres; this service only runs tasks dispatched via HTTP.

1. OArmour inserts a task in `BrowserAgentTask` (status `QUEUED`), then `POST`s to `/v1/sessions` with `{ extensionId, version, sessionId }`.
2. The agent accepts when a concurrency slot is free (default **1**, override with `BROWSER_AGENT_MAX_CONCURRENT`); returns **429** when at capacity.
3. Processing validates the expected layout:
   - `$EXTENSION_STORAGE_ROOT/chrome-extension-analyzer/<id>/<version>/` must exist (unpacked extension).
   - `$AGENT_QUEUE_ROOT/extension-data/<id>/<version>/cli_config.json` is created if missing (`chromium`; default `userDataDir` is `<sidecar>/.playwright-profile`; override with `PLAYWRIGHT_CLI_USER_DATA_DIR`; headless by default, set `PLAYWRIGHT_CLI_HEADLESS=0` to disable).
   - Prompt resolution prefers `$AGENT_QUEUE_ROOT/extension-data/<id>/prompt.md`, then falls back to `$AGENT_QUEUE_ROOT/prompt.md` (OArmour seeds the default from its bundled template; standalone runs copy `resources/default-extension-test-prompt.md` when missing).
4. `runExtensionAgent` loads `prompt.md` and drives tools such as `playwright-cli`.
   - **Browser guard** around `playwright-cli open`: by default **`playwright-cli close-all` runs before each open** (disable with `BROWSER_GUARD_CLOSE_ALL_BEFORE_OPEN=0`); reuse an existing `--profile` when present (and clear common Chromium lock files like `SingletonLock` before launch); if the command has no `--profile`, append `--persistent` and use an isolated profile at `$AGENT_QUEUE_ROOT/extension-data/<id>/<version>/ai_testing/<runId>/.playwright-profile` to reduce `Browser is already in use` failures.
   - Service logs use `lib/app-logger.ts` (ISO prefix, same style as oarmour-site): `[browseragent]`, `[browser-guard]`, `[shot-guard]`, `[control-plane]`, `[run]`, `[tool]`. Verbosity: `AGENT_LOG_TOOLS`, `AGENT_LOG_THINKING`, `AGENT_DEBUG_QUEUE`, `DEBUG_AGENT` (see `.env.example`).
5. During the run, `record_step` appends to `$AGENT_QUEUE_ROOT/extension-data/<id>/<version>/ai_testing/<runId>/recordings.json` and stores screenshots in the same folder.
6. On success or failure, `status.json` is updated with:
   - `status` (`running` / `complete` / `error`)
   - `status_time`
   - `duration` (seconds)
7. **Task timeout** per run: when the agent budget is exceeded, the service **finalizes artifacts before** marking `error`:
   - Waits for in-flight `shell_command` (e.g. `playwright-cli screenshot`) to finish.
   - Syncs screenshot files referenced in `recordings.json` under `ai_testing/<runId>/`.
   - Saves `ai_testing/<runId>/network.json` via `playwright-cli network` (empty `requests` if none).
   - Then sets status to `error` with `Task timed out after <ms>ms (...)`.
   - Agent budget default: 10 minutes (`600000` ms), override with `TASK_TIMEOUT_MS`.
   - Finalize budget default: 2 minutes (`120000` ms), override with `TASK_FINALIZE_TIMEOUT_MS` (extra wall time after the agent budget; not included in the timeout error message).
   - Example:
     ```bash
     TASK_TIMEOUT_MS=600000 TASK_FINALIZE_TIMEOUT_MS=120000 npm run dev
     ```
   - Startup logs print both budgets.

```bash
npm run dev
```

**Run only one extension (optional):** legacy `--eid` filter is no longer used in HTTP dispatch mode.

**Direct run (no HTTP):** pass `--run-extension <id>` to run one AI session immediately from unpacked files under `chrome-extension-analyzer/<id>/`, then **exit**. Still writes `status.json` and uses the same timeout (`TASK_TIMEOUT_MS`). If `--version` is omitted, the newest version folder under that id (by directory mtime) is chosen.

```bash
npm run dev -- --run-extension nkbihfbeogaeaoehlefnkodbefgpgknn
npm run dev -- --run-extension nkbihfbeogaeaoehlefnkodbefgpgknn --version 12.17.3_0
npm run dev -- --run-extension nkbihfbeogaeaoehlefnkodbefgpgknn --artifact-root /abs/path/to/unpacked
```

Shorthand: `--run <id>` or `--run-extension=<id>`. With `--run-extension`, `--eid` is ignored.

### Dispatch a Task Locally (dev)

With `npm run dev` running, POST a session to the control plane:

```bash
# Default extension/version; uses BROWSER_AGENT_API_URL or http://127.0.0.1:8791
npm run enqueue:task

# Custom fields (--run-id / --session-id must match OArmour sessionId when testing end-to-end)
npm run enqueue:task -- --id nkbihfbeogaeaoehlefnkodbefgpgknn --name MetaMask --version 12.17.3_0 --session-id 20260523120000-nkbihfbe-12.17.3_0
```

Production enqueue goes through OArmour Admin → Browser Agent or the monitor pipeline (Postgres queue + HTTP dispatch).

---

## Troubleshooting: Why Chrome for Testing Didn't Launch (and How We Fixed It)

When running `node index.ts`, the agent originally tried to use `playwright-cli open`, which led to several cascading issues. Here's the full breakdown:

### 1. `playwright-cli open` Defaults to System Chrome

`playwright-cli`'s `open` command defaults to the `chrome` channel (i.e., `/Applications/Google Chrome.app`). Even though we had `browserName: "chromium"` in our config file, the CLI either ignores or doesn't recognize that field. So the browser that launched was **system Chrome**, not Chrome for Testing (CFT).

### 2. Missing `--persistent` + `--profile` Flags

By default `playwright-cli open` uses an **in-memory** user data profile (`user-data-dir: <in-memory>`). Chrome extensions require a persistent profile to load properly. Without it, the browser starts but the extension never gets activated, leading to `No EIP-6963 Provider Detected` on web dapps.

### 3. Chrome Crashes: Sandbox / GPU Initialization Failed

Even when we got the right flags, Chrome under Playwright's sandboxed launch would crash immediately:

```
Failed to initialize sandbox. sandbox initialization failed: Operation not permitted
GPU process isn't usable. Goodbye.
```

This happens because Playwright's automated test environment restricts certain system calls. Fix: add `--no-sandbox` and `--disable-gpu` to the `browser.launchOptions.args` array in the extension artifact’s **`cli_config.json`** (or adjust the auto-generated file after it is created).

### 4. Chrome for Testing Binaries Were Never Downloaded

Running `playwright-cli install --skills` downloads a version of CFT, but the `playwright` npm package (used by `chromium.launchPersistentContext`) looks for a different version in `~/Library/Caches/ms-playwright/`. If the download is interrupted or versions don't match, you get:

```
Executable doesn't exist at .../Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing
```

Fix: run `npx playwright install chromium` separately.

### 5. Config File Path Was Wrong in the Agent Prompt

The agent prompt must reference **`cli_config.json`** with a path that resolves from the shell cwd (prefer an absolute path under `$AGENT_QUEUE_ROOT/extension-data/<id>/<version>/cli_config.json`).

---

## Summary of Steps Taken to Make It Work

| # | Issue | Fix |
|---|---|---|
| 1 | **Config file rename** | Renamed `pi-agent.config.json` to `config.json`; updated `loadFileConfig()` in [index.ts](file:///Volumes/T7/repos/pi-agent-browser/index.ts#L73-L77) to check both names. |
| 2 | **Missing `bip39` dependency** | Added `bip39` + `@types/bip39` to `package.json`; ran `npm install`. |
| 3 | **Extension unpacking** | Extracted `metamask.crx` to the shared artifact root (stripped CRX header to get ZIP, then unzipped). |
| 4 | **Chrome crash on launch** | Added `--no-sandbox` and `--disable-gpu` to extension artifact `cli_config.json` launch args. |
| 5 | **Persistent profile required** | Launch command now uses `--persistent --profile=/Volumes/T7/repos/pi-agent-browser/.playwright/profile`. |
| 6 | **CFT binaries missing** | Ran `npx playwright install chromium` to download Chrome for Testing. |
| 7 | **Config path in prompt** | Use absolute path to extension artifact `cli_config.json` in agent instructions. |
| 8 | **Verified injection** | Confirmed `window.ethereum` and `window.ethereum.isMetaMask` are `true` on the MetaMask test dapp. |

---

## Running with MetaMask

```bash
# Ensure everything is set up
npx playwright install chromium

# Launch the agent (queue tasks; each run uses `$AGENT_QUEUE_ROOT/extension-data/<id>/<version>/cli_config.json`)
node index.ts
```

Or launch the browser manually from an unpacked extension directory:

```bash
playwright-cli close-all
playwright-cli open \
  --config=/absolute/path/to/agent-queue/extension-data/<extensionId>/<version>/cli_config.json \
  --headed \
  --persistent \
  --profile=/path/to/your/playwright-profile
```

Then verify MetaMask is loaded on a normal **HTTPS** page (e.g. a test dapp tab), not on `chrome-extension://` UI—extension pages often **block `eval`**, so `playwright-cli eval` can fail there. See `resources/metamask-prompt.md` for prompt constraints.

```bash
playwright-cli eval 'Boolean(window.ethereum && window.ethereum.isMetaMask)'
# Expected: ### Result\n"true"
```
