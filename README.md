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
#    Edit config.json with your API key, or set env vars:
#    ANTHROPIC_AUTH_TOKEN=xxx npm run dev
npm run dev
```

## Project Structure

| Path | Purpose |
|---|---|
| `index.ts` | Main agent entry point |
| `processings/incoming_queue.json` | Extension queue source file (was `ext_list.json`) |
| `processings/status.json` | Processing state for each extension |
| `config.json` | AI provider configuration (model, API key, base URL) |
| `cli.config.json` | Legacy config (root-level) |
| `.playwright/cli.config.json` | Playwright CLI launch config (extension, profile, HAR) |
| `samples/metamask/` | Unpacked MetaMask Chrome extension |

### Queue and Status Fields

- `processings/incoming_queue.json`
  - `incoming_time`: queue entry creation time in ISO 8601 format
- `processings/status.json`
  - `status_time`: last status update time in ISO 8601 format
  - `duration`: elapsed seconds from `incoming_time` to current status update

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

This happens because Playwright's automated test environment restricts certain system calls. Fix: add `--no-sandbox` and `--disable-gpu` to the launch args in `.playwright/cli.config.json`.

### 4. Chrome for Testing Binaries Were Never Downloaded

Running `playwright-cli install --skills` downloads a version of CFT, but the `playwright` npm package (used by `chromium.launchPersistentContext`) looks for a different version in `~/Library/Caches/ms-playwright/`. If the download is interrupted or versions don't match, you get:

```
Executable doesn't exist at .../Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing
```

Fix: run `npx playwright install chromium` separately.

### 5. Config File Path Was Wrong in the Agent Prompt

The default prompt in `index.ts` pointed to `.playwright/cli.config.json` using a relative path. Depending on the agent's working directory, this could resolve to the wrong file or miss entirely. Fix: use the absolute path `/Volumes/T7/repos/pi-agent-browser/.playwright/cli.config.json`.

---

## Summary of Steps Taken to Make It Work

| # | Issue | Fix |
|---|---|---|
| 1 | **Config file rename** | Renamed `pi-agent.config.json` to `config.json`; updated `loadFileConfig()` in [index.ts](file:///Volumes/T7/repos/pi-agent-browser/index.ts#L73-L77) to check both names. |
| 2 | **Missing `bip39` dependency** | Added `bip39` + `@types/bip39` to `package.json`; ran `npm install`. |
| 3 | **Extension unpacking** | Extracted `metamask.crx` to `samples/metamask/` (stripped CRX header to get ZIP, then unzipped). |
| 4 | **Chrome crash on launch** | Added `--no-sandbox` and `--disable-gpu` to `.playwright/cli.config.json` launch args. |
| 5 | **Persistent profile required** | Launch command now uses `--persistent --profile=/Volumes/T7/repos/pi-agent-browser/.playwright/profile`. |
| 6 | **CFT binaries missing** | Ran `npx playwright install chromium` to download Chrome for Testing. |
| 7 | **Config path in prompt** | Updated the default agent prompt in [index.ts](file:///Volumes/T7/repos/pi-agent-browser/index.ts#L381) to use the absolute path to `.playwright/cli.config.json`. |
| 8 | **Verified injection** | Confirmed `window.ethereum` and `window.ethereum.isMetaMask` are `true` on the MetaMask test dapp. |

---

## Running with MetaMask

```bash
# Ensure everything is set up
npx playwright install chromium

# Launch the agent (it will use .playwright/cli.config.json which loads MetaMask)
node index.ts
```

Or launch the browser manually:

```bash
playwright-cli close-all
playwright-cli open \
  --config=/Volumes/T7/repos/pi-agent-browser/.playwright/cli.config.json \
  --headed \
  --persistent \
  --profile=/Volumes/T7/repos/pi-agent-browser/.playwright/profile
```

Then verify MetaMask is loaded:

```bash
playwright-cli eval 'Boolean(window.ethereum && window.ethereum.isMetaMask)'
# Expected: ### Result\n"true"
```
