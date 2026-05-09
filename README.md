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
#    Edit config/pi-agent.config.json with your API key, or set env vars:
#    ANTHROPIC_AUTH_TOKEN=xxx npm run dev
npm run dev
```

## Project Structure

| Path | Purpose |
|---|---|
| `index.ts` | Main prompt-driven processing service entry |
| `samples/incoming_queue.json` | Primary queue source (兼容 `processings/incoming_queue.json`) |
| `samples/status.json` | Primary processing state (兼容 `processings/status.json`) |
| `config/pi-agent.config.json` | AI provider configuration (model, API key, base URL) |
| `samples/<extensionId>/<version>/` | Unpacked extension exact version directory |
| `samples/<extensionId>/cli_config.json` | Runtime config (兼容 `cli.config.json`) |
| `samples/<extensionId>/prompt.md` | Runtime prompt file |
| `samples/<extensionId>/ai_testing/<index>/` | Agent execution artifacts (`recordings.json` and screenshots) |
| `scripts/enqueue-task.ts` | Simulate external system queue push |

### Queue and Status Fields

- `samples/incoming_queue.json`（兼容 `processings/incoming_queue.json`）
  - `incoming_time`: queue entry creation time in ISO 8601 format
- `samples/status.json`（兼容 `processings/status.json`）
  - `status_time`: last status update time in ISO 8601 format
  - `duration`: elapsed seconds from `incoming_time` to current status update

---

## Processing Flow (Prompt-Agent + Playwright CLI)

`node index.ts` 会启动一个常驻服务，核心规则如下：

1. 仅在服务 `idle` 时才会从 `incoming_queue.json` 取任务。
2. 每次只取队列中“最新一条”（按 `incoming_time`，同时间按 `index`）。
3. 处理时会校验扩展固定结构：
   - `samples/<id>/<version>/` 必须存在
   - `samples/<id>/cli_config.json`（兼容 `cli.config.json`）必须存在
   - `samples/<id>/prompt.md` 必须存在
4. 调用 `runExtensionAgent` 读取 `prompt.md`，由 prompt 驱动 Agent 调用 `playwright-cli` 等工具执行真实流程。
5. 运行过程中通过 `record_step` 工具向 `samples/<id>/ai_testing/<index>/recordings.json` 持续写入步骤，并保存对应截图。
6. 完成或失败后，`status.json` 会更新：
   - `status` (`running` / `complete` / `error`)
   - `status_time`（当前时间）
   - `duration`（秒）
7. 单任务硬超时：每个任务执行存在硬超时，超过后会强制以 `status=error` 收尾，错误信息形如 `Task timed out after <ms>ms (id=..., index=...)`，并刷新 `status_time` / `duration`。
   - 默认 10 分钟（`600000` ms）。
   - 通过环境变量 `TASK_TIMEOUT_MS` 覆盖（毫秒），例如：
     ```bash
     TASK_TIMEOUT_MS=300000 npm run dev   # 5 分钟
     ```
   - 启动日志会打印当前生效的超时值，便于排查任务卡死。

```bash
npm run dev
```

### Simulate External Queue Push

新增独立脚本模拟外部系统入队（不会污染 `index.ts`）：

```bash
# 使用默认参数写入一条任务
npm run enqueue:task

# 自定义任务参数
npm run enqueue:task -- --id nkbihfbeogaeaoehlefnkodbefgpgknn --name MetaMask --version 12.17.3_0 --index 1001
```

脚本会优先写入 `samples/incoming_queue.json`，兼容 `processings/incoming_queue.json`。

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
