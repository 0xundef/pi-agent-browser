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
| `$AGENT_QUEUE_ROOT/incoming_queue.json` | Queue source (defaults to `$EXTENSION_STORAGE_ROOT/agent-queue/incoming_queue.json`) |
| `$AGENT_QUEUE_ROOT/status.json` | Primary processing state |
| `config/pi-agent.config.json` | AI provider configuration (model, API key, base URL) |
| `$EXTENSION_STORAGE_ROOT/chrome-extension-analyzer/<extensionId>/<version>/` | Unpacked extension exact version directory |
| `$EXTENSION_STORAGE_ROOT/chrome-extension-analyzer/<extensionId>/prompt.md` | Optional **per-extension** prompt (overrides global) |
| `$AGENT_QUEUE_ROOT/prompt.md` | **Default prompt** for all extensions; OArmour seeds this from its bundled template on enqueue; locally, `resources/default-extension-test-prompt.md` is copied here if missing |
| `<artifactRoot>/cli_config.json` | Runtime config; **auto-created** if missing (`chromium`, `headless` default true, `userDataDir` = `<artifact>/.playwright-profile`, `--no-sandbox` / `--disable-setuid-sandbox`, dynamic `--load-extension` paths) |
| `<artifactRoot>/ai_testing/<runId>/` | Agent execution artifacts (`recordings.json` and screenshots) |
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

`node index.ts` 会启动一个常驻服务，核心规则如下：

1. 仅在服务 `idle` 时才会从 `incoming_queue.json` 取任务。
2. 每次只取队列中“最新一条”（按 `incoming_time`，同时间按 `index`）。
3. 处理时会校验扩展固定结构：
   - `$EXTENSION_STORAGE_ROOT/chrome-extension-analyzer/<id>/<version>/` 必须存在
   - `<artifactRoot>/cli_config.json`：若不存在会自动生成（chromium、`userDataDir` 默认 `<artifactRoot>/.playwright-profile`，可用 `PLAYWRIGHT_CLI_USER_DATA_DIR` 覆盖；默认 headless，可用 `PLAYWRIGHT_CLI_HEADLESS=0` 关闭）
   - 优先 `chrome-extension-analyzer/<id>/prompt.md`；不存在则使用 `AGENT_QUEUE_ROOT/prompt.md`（OArmour 会从内置模板同步；独立运行时会从 `resources/default-extension-test-prompt.md` 复制）
4. 调用 `runExtensionAgent` 读取 `prompt.md`，由 prompt 驱动 Agent 调用 `playwright-cli` 等工具执行真实流程。
   - 对 `playwright-cli open` 增加“浏览器会话保护”最小策略：**每次 open 前默认执行一次 `playwright-cli close-all`**（可通过 `BROWSER_GUARD_CLOSE_ALL_BEFORE_OPEN=0` 关闭）；优先复用命令里已有 `--profile`（并在启动前清理常见 Chromium 锁文件 `SingletonLock` 等）；若命令未带 `--profile`，则自动追加 `--persistent` 并隔离到 `<artifactRoot>/ai_testing/<runId>/.playwright-profile`，降低 `Browser is already in use` 链式失败概率。
   - 启动日志会打印 `[browser-guard]`，用于观察 close-all / 锁清理 / 隔离目录是否生效。
5. 运行过程中通过 `record_step` 工具向 `<artifactRoot>/ai_testing/<runId>/recordings.json` 持续写入步骤，并保存对应截图。
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

**Run only one extension (optional):** pass `--eid` so the service only picks queue rows whose `id` matches (other extensions in the queue are ignored until you restart without the flag).

```bash
npm run dev -- --eid nkbihfbeogaeaoehlefnkodbefgpgknn
```

### Simulate External Queue Push

新增独立脚本模拟外部系统入队（不会污染 `index.ts`）：

```bash
# 使用默认参数写入一条任务
npm run enqueue:task

# 自定义任务参数
npm run enqueue:task -- --id nkbihfbeogaeaoehlefnkodbefgpgknn --name MetaMask --version 12.17.3_0 --index 1001
```

脚本会写入 `$AGENT_QUEUE_ROOT/incoming_queue.json`；未设置时默认写入 `$EXTENSION_STORAGE_ROOT/agent-queue/incoming_queue.json`。

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

The agent prompt must point at the extension artifact’s **`cli_config.json`** using a path that resolves correctly from the shell cwd (prefer an absolute path to `…/chrome-extension-analyzer/<id>/<version>/cli_config.json`).

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

# Launch the agent (queue tasks; each run uses `<artifactRoot>/cli_config.json`)
node index.ts
```

Or launch the browser manually from an unpacked extension directory:

```bash
playwright-cli close-all
playwright-cli open \
  --config=/absolute/path/to/chrome-extension-analyzer/<extensionId>/<version>/cli_config.json \
  --headed \
  --persistent \
  --profile=/path/to/your/playwright-profile
```

Then verify MetaMask is loaded on a normal **HTTPS** page (e.g. a test dapp tab), not on `chrome-extension://` UI—extension pages often **block `eval`**, so `playwright-cli eval` can fail there. See `resources/metamask-prompt.md` for prompt constraints.

```bash
playwright-cli eval 'Boolean(window.ethereum && window.ethereum.isMetaMask)'
# Expected: ### Result\n"true"
```
