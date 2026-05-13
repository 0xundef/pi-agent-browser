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
| `index.ts` | Main prompt-driven processing service entry |
| `$AGENT_QUEUE_ROOT/incoming_queue.json` | Queue source (defaults to `$EXTENSION_STORAGE_ROOT/agent-queue/incoming_queue.json`) |
| `$AGENT_QUEUE_ROOT/status.json` | Primary processing state |
| `.env` (from `.env.example`) | AI provider credentials and model (`PI_*`, `ANTHROPIC_*`, `OPENAI_*`); loaded via `dotenv` |
| `config/pi-agent.config.json` | Optional JSON provider config (same shape as before); use `PI_CONFIG` to point elsewhere |
| `$EXTENSION_STORAGE_ROOT/chrome-extension-analyzer/<extensionId>/<version>/` | Unpacked extension exact version directory |
| `$AGENT_QUEUE_ROOT/extension-data/<extensionId>/prompt.md` | Optional **per-extension** prompt (overrides global) |
| `$AGENT_QUEUE_ROOT/prompt.md` | **Default prompt** for all extensions; OArmour seeds this from its bundled template on enqueue; locally, `resources/default-extension-test-prompt.md` is copied here if missing |
| `$AGENT_QUEUE_ROOT/extension-data/<extensionId>/<version>/cli_config.json` | Runtime config; **auto-created** if missing (`chromium`, `headless` default true, `userDataDir` defaults to `<sidecar>/.playwright-profile`, `--no-sandbox` / `--disable-setuid-sandbox`, `--load-extension` points at unpacked extension under `chrome-extension-analyzer`) |
| `$AGENT_QUEUE_ROOT/extension-data/<extensionId>/<version>/ai_testing/<runId>/` | Agent execution artifacts (`recordings.json` and screenshots) |
| `scripts/enqueue-task.ts` | Simulate external system queue push |

### Queue and Status Fields

- `$AGENT_QUEUE_ROOT/incoming_queue.json`
  - `incoming_time`: queue entry creation time in ISO 8601 format
- `$AGENT_QUEUE_ROOT/status.json`
  - `status_time`: last status update time in ISO 8601 format
  - `duration`: elapsed seconds from `incoming_time` to current status update
  - `runId`: stable output folder name under `ai_testing/<runId>/`

---

## Processing Flow (Prompt-Agent + Playwright CLI)

`node index.ts` starts a long-running service. Core behavior:

1. Tasks are read from `incoming_queue.json` only while the service is **idle** (not already running a job).
2. Each pick takes the **newest** queue entry (`incoming_time`, then `index` if tied).
3. Processing validates the expected layout:
   - `$EXTENSION_STORAGE_ROOT/chrome-extension-analyzer/<id>/<version>/` must exist (unpacked extension).
   - `$AGENT_QUEUE_ROOT/extension-data/<id>/<version>/cli_config.json` is created if missing (`chromium`; default `userDataDir` is `<sidecar>/.playwright-profile`; override with `PLAYWRIGHT_CLI_USER_DATA_DIR`; headless by default, set `PLAYWRIGHT_CLI_HEADLESS=0` to disable).
   - Prompt resolution prefers `$AGENT_QUEUE_ROOT/extension-data/<id>/prompt.md`, then falls back to `$AGENT_QUEUE_ROOT/prompt.md` (OArmour seeds the default from its bundled template; standalone runs copy `resources/default-extension-test-prompt.md` when missing).
4. `runExtensionAgent` loads `prompt.md` and drives tools such as `playwright-cli`.
   - **Browser guard** around `playwright-cli open`: by default **`playwright-cli close-all` runs before each open** (disable with `BROWSER_GUARD_CLOSE_ALL_BEFORE_OPEN=0`); reuse an existing `--profile` when present (and clear common Chromium lock files like `SingletonLock` before launch); if the command has no `--profile`, append `--persistent` and use an isolated profile at `$AGENT_QUEUE_ROOT/extension-data/<id>/<version>/ai_testing/<runId>/.playwright-profile` to reduce `Browser is already in use` failures.
   - Logs tagged `[browser-guard]` show close-all, lock cleanup, and isolated profile usage.
5. During the run, `record_step` appends to `$AGENT_QUEUE_ROOT/extension-data/<id>/<version>/ai_testing/<runId>/recordings.json` and stores screenshots in the same folder.
6. On success or failure, `status.json` is updated with:
   - `status` (`running` / `complete` / `error`)
   - `status_time`
   - `duration` (seconds)
7. **Hard timeout** per task: if the run exceeds the limit, status is set to `error` with a message like `Task timed out after <ms>ms (id=..., index=...)`, and `status_time` / `duration` are refreshed.
   - Default: 10 minutes (`600000` ms).
   - Override with `TASK_TIMEOUT_MS` (milliseconds), for example:
     ```bash
     TASK_TIMEOUT_MS=300000 npm run dev   # 5 minutes
     ```
   - Startup logs print the effective timeout to help debug stuck tasks.

```bash
npm run dev
```

**Run only one extension (optional):** pass `--eid` so the service only picks queue rows whose `id` matches (other extensions in the queue are ignored until you restart without the flag).

```bash
npm run dev -- --eid nkbihfbeogaeaoehlefnkodbefgpgknn
```

**Direct run (no queue):** pass `--run-extension <id>` to run one AI session immediately from unpacked files under `chrome-extension-analyzer/<id>/`, then **exit**. Does not read `incoming_queue.json` or start queue file watchers. Still writes `status.json` and uses the same timeout (`TASK_TIMEOUT_MS`). If `--version` is omitted, the newest version folder under that id (by directory mtime) is chosen.

```bash
npm run dev -- --run-extension nkbihfbeogaeaoehlefnkodbefgpgknn
npm run dev -- --run-extension nkbihfbeogaeaoehlefnkodbefgpgknn --version 12.17.3_0
npm run dev -- --run-extension nkbihfbeogaeaoehlefnkodbefgpgknn --artifact-root /abs/path/to/unpacked
```

Shorthand: `--run <id>` or `--run-extension=<id>`. With `--run-extension`, `--eid` is ignored.

### Simulate External Queue Push

Use the standalone script to mimic an external enqueue (keeps `index.ts` unchanged):

```bash
# Enqueue one task with default fields
npm run enqueue:task

# Custom fields
npm run enqueue:task -- --id nkbihfbeogaeaoehlefnkodbefgpgknn --name MetaMask --version 12.17.3_0 --index 1001
```

The script writes `$AGENT_QUEUE_ROOT/incoming_queue.json`. When `AGENT_QUEUE_ROOT` is unset, the default is `$EXTENSION_STORAGE_ROOT/agent-queue/incoming_queue.json`.

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
