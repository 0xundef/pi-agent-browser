import dotenv from "dotenv";
import { Agent, type AgentEvent, type AgentTool } from "@mariozechner/pi-agent-core";
import { Type, getEnvApiKey, getModels, type KnownProvider, type Model, type Static } from "@mariozechner/pi-ai";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import * as bip39 from "bip39";
import { clearNetworkCapture, saveNetworkCapture } from "./lib/network-capture.js";
import { maybeStartControlPlaneServer } from "./lib/control-plane-server.js";
import { registerRunExecutor, isSessionCancelled, type RunRequest } from "./lib/run-coordinator.js";
import {
  beginShellCommand,
  endShellCommand,
  isFinalizeRequested,
} from "./lib/run-shell-tracker.js";
import { resolveTaskFinalizeTimeoutMs } from "./lib/run-artifacts-finalize.js";
import { logError, logInfo, logWarn } from "./lib/app-logger.js";
import {
  agentDebugEventsEnabled,
  agentThinkingLogsEnabled,
  agentToolLogsEnabled,
} from "./lib/log-flags.js";
import { runWithTimeoutAndFinalize } from "./lib/run-timeout.js";

dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

type FileConfig = {
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  systemPrompt?: string;
  anthropicAuthToken?: string;
  anthropicBaseUrl?: string;
  openaiAuthToken?: string;
  openaiBaseUrl?: string;
  providers?: ProviderEntry[];
};

type RuntimeConfig = {
  provider: KnownProvider;
  modelName: string;
  apiKey?: string;
  baseUrl?: string;
  systemPrompt: string;
};

type ProviderEntry = {
  enable?: boolean;
  enalble?: boolean;
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  systemPrompt?: string;
  anthropicAuthToken?: string;
  anthropicBaseUrl?: string;
  openaiAuthToken?: string;
  openaiBaseUrl?: string;
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function parseProviderEntry(value: unknown): ProviderEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  return {
    enable: asBoolean(obj.enable),
    enalble: asBoolean(obj.enalble),
    provider: asString(obj.provider),
    model: asString(obj.model),
    apiKey: asString(obj.apiKey),
    baseUrl: asString(obj.baseUrl),
    systemPrompt: asString(obj.systemPrompt),
    anthropicAuthToken: asString(obj.anthropicAuthToken ?? obj.ANTHROPIC_AUTH_TOKEN),
    anthropicBaseUrl: asString(obj.anthropicBaseUrl ?? obj.ANTHROPIC_BASE_URL),
    openaiAuthToken: asString(obj.openaiAuthToken ?? obj.OPENAI_AUTH_TOKEN ?? obj.openaiApiKey ?? obj.OPENAI_API_KEY),
    openaiBaseUrl: asString(obj.openaiBaseUrl ?? obj.OPENAI_BASE_URL)
  };
}

function parseConfigPath(): string | undefined {
  return process.env.PI_CONFIG_JSON ?? process.env.PI_CONFIG;
}

function loadFileConfig(): FileConfig {
  const requestedPath = parseConfigPath();
  const configPath = requestedPath
    ? path.resolve(requestedPath)
    : [
      path.resolve(process.cwd(), "config/config.json"),
      path.resolve(process.cwd(), "config/pi-agent.config.json"),
      path.resolve(process.cwd(), "config.json"),
      path.resolve(process.cwd(), "pi-agent.config.json")
    ].find(existsSync);

  if (!configPath || !existsSync(configPath)) {
    return {};
  }

  const raw = readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const providers = Array.isArray(parsed.providers)
    ? (parsed.providers.map(parseProviderEntry).filter(Boolean) as ProviderEntry[])
    : undefined;
  return {
    provider: asString(parsed.provider),
    model: asString(parsed.model),
    apiKey: asString(parsed.apiKey),
    baseUrl: asString(parsed.baseUrl),
    systemPrompt: asString(parsed.systemPrompt),
    anthropicAuthToken: asString(parsed.anthropicAuthToken ?? parsed.ANTHROPIC_AUTH_TOKEN),
    anthropicBaseUrl: asString(parsed.anthropicBaseUrl ?? parsed.ANTHROPIC_BASE_URL),
    openaiAuthToken: asString(parsed.openaiAuthToken ?? parsed.OPENAI_AUTH_TOKEN ?? parsed.openaiApiKey ?? parsed.OPENAI_API_KEY),
    openaiBaseUrl: asString(parsed.openaiBaseUrl ?? parsed.OPENAI_BASE_URL),
    providers
  };
}

function inferProviderFromEnvKeys(): KnownProvider | undefined {
  const hasAnthropic = !!(
    process.env.ANTHROPIC_AUTH_TOKEN ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.ANTHROPIC_OAUTH_TOKEN
  );
  const hasOpenai = !!(
    process.env.OPENAI_API_KEY ||
    process.env.OPENAI_AUTH_TOKEN ||
    process.env.OPENAI_OAUTH_TOKEN
  );
  if (hasAnthropic && !hasOpenai) return "anthropic";
  if (hasOpenai && !hasAnthropic) return "openai";
  return undefined;
}

function resolveRuntimeConfig(fileConfig: FileConfig): RuntimeConfig {
  const configuredProvider = fileConfig.provider ?? process.env.PI_PROVIDER;
  const providers = fileConfig.providers ?? [];
  const enabledProviders = providers.filter((p) => (p.enable ?? p.enalble) === true);

  const selected =
    (configuredProvider ? enabledProviders.find((p) => p.provider === configuredProvider) : undefined) ??
    enabledProviders[0] ??
    providers[0];

  const provider =
    ((selected?.provider ??
      configuredProvider ??
      inferProviderFromEnvKeys() ??
      "openai") as KnownProvider) ?? "openai";
  const rawModel = selected?.model ?? fileConfig.model ?? process.env.PI_MODEL;
  const modelName =
    rawModel ?? (provider === "anthropic" ? "claude-sonnet-4-20250514" : "gpt-4o-mini");
  const baseUrl = normalizedBaseUrl(
    selected?.baseUrl ??
      selected?.anthropicBaseUrl ??
      selected?.openaiBaseUrl ??
      fileConfig.baseUrl ??
      fileConfig.anthropicBaseUrl ??
      fileConfig.openaiBaseUrl ??
      process.env.ANTHROPIC_BASE_URL ??
      process.env.OPENAI_BASE_URL,
  );
  const apiKey =
    selected?.apiKey ??
    selected?.anthropicAuthToken ??
    selected?.openaiAuthToken ??
    fileConfig.apiKey ??
    fileConfig.anthropicAuthToken ??
    fileConfig.openaiAuthToken ??
    getApiKeyForProvider(provider);
  const systemPrompt =
    selected?.systemPrompt ??
    fileConfig.systemPrompt ??
    (process.env.PI_SYSTEM_PROMPT?.trim() || undefined) ??
    "You are a helpful assistant. Use tools when they are useful.";
  return { provider, modelName, apiKey, baseUrl, systemPrompt };
}

function normalizedBaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.trim().replace(/[`"' ]/g, "");
  return cleaned.length > 0 ? cleaned : undefined;
}

function getApiKeyForProvider(provider: KnownProvider): string | undefined {
  if (provider === "anthropic") {
    return process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_OAUTH_TOKEN;
  }
  return getEnvApiKey(provider as any);
}

function withProviderOverrides(provider: KnownProvider, model: Model<any>, baseUrl?: string, apiKey?: string): Model<any> {
  const normalized = normalizedBaseUrl(baseUrl);
  if (provider === "anthropic") {
    const headers: Record<string, string> = { ...(model.headers ?? {}) };
    if (apiKey) {
      headers["x-api-key"] = apiKey;
      headers.Authorization = `Bearer ${apiKey}`;
    }
    const next: Model<any> = { ...model };
    if (normalized) next.baseUrl = normalized;
    if (Object.keys(headers).length > 0) next.headers = headers;
    return next;
  }
  if (normalized) {
    return { ...model, baseUrl: normalized };
  }
  return model;
}

function getDemoModel(runtime: RuntimeConfig): Model<any> {
  const provider = runtime.provider;
  const modelName = runtime.modelName;
  const models = getModels(provider) as Model<any>[];
  const byId = models.find((m) => m.id === modelName);
  if (byId) return withProviderOverrides(provider, byId, runtime.baseUrl, runtime.apiKey);
  const byName = models.find((m) => m.name === modelName);
  if (byName) return withProviderOverrides(provider, byName, runtime.baseUrl, runtime.apiKey);
  if (models[0]) {
    return withProviderOverrides(
      provider,
      {
        ...models[0],
        id: modelName,
        name: modelName
      },
      runtime.baseUrl,
      runtime.apiKey,
    );
  }
  const fallback = models.find((m) => m.id === "gpt-4o-mini") ?? models[0];
  if (!fallback) {
    throw new Error(`No models found for provider '${provider}'.`);
  }
  return withProviderOverrides(provider, fallback, runtime.baseUrl, runtime.apiKey);
}

function envVarHintForProvider(provider: KnownProvider): string {
  switch (provider) {
    case "openai":
      return "OPENAI_API_KEY (or openaiAuthToken/apiKey in JSON), optional OPENAI_BASE_URL";
    case "anthropic":
      return "ANTHROPIC_AUTH_TOKEN (or ANTHROPIC_API_KEY / ANTHROPIC_OAUTH_TOKEN), optional ANTHROPIC_BASE_URL";
    case "google":
      return "GEMINI_API_KEY";
    case "google-vertex":
      return "GOOGLE_CLOUD_PROJECT + GOOGLE_CLOUD_LOCATION (+ ADC)";
    case "mistral":
      return "MISTRAL_API_KEY";
    case "groq":
      return "GROQ_API_KEY";
    case "cerebras":
      return "CEREBRAS_API_KEY";
    case "xai":
      return "XAI_API_KEY";
    case "openrouter":
      return "OPENROUTER_API_KEY";
    case "vercel-ai-gateway":
      return "AI_GATEWAY_API_KEY";
    case "zai":
      return "ZAI_API_KEY";
    case "github-copilot":
      return "COPILOT_GITHUB_TOKEN (or GH_TOKEN)";
    case "azure-openai-responses":
      return "AZURE_OPENAI_API_KEY (+ AZURE_OPENAI_BASE_URL)";
    default:
      return "provider-specific API key env var";
  }
}

const getTimeParameters = Type.Object({
  timezone: Type.Optional(Type.String({ description: "IANA timezone (e.g. UTC, America/New_York)" }))
});
type GetTimeParameters = Static<typeof getTimeParameters>;

const getTimeTool: AgentTool<typeof getTimeParameters, { timezone: string; iso: string }> = {
  name: "get_time",
  label: "Get time",
  description: "Returns the current time, optionally for a specific IANA timezone.",
  parameters: getTimeParameters,
  async execute(_toolCallId: string, params: GetTimeParameters) {
    const timezone = params.timezone ?? "UTC";
    const now = new Date();
    const formatted = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      dateStyle: "full",
      timeStyle: "long"
    }).format(now);

    return {
      content: [{ type: "text", text: formatted }],
      details: { timezone, iso: now.toISOString() }
    };
  }
};

const addParameters = Type.Object({
  a: Type.Number(),
  b: Type.Number()
});
type AddParameters = Static<typeof addParameters>;

const addTool: AgentTool<typeof addParameters, { a: number; b: number; sum: number }> = {
  name: "add",
  label: "Add numbers",
  description: "Adds two numbers and returns the sum.",
  parameters: addParameters,
  async execute(_toolCallId: string, params: AddParameters) {
    const sum = params.a + params.b;
    return {
      content: [{ type: "text", text: String(sum) }],
      details: { a: params.a, b: params.b, sum }
    };
  }
};

const shellCommandParameters = Type.Object({
  command: Type.String({ description: "The shell command to execute" }),
  cwd: Type.Optional(Type.String({ description: "Working directory (defaults to current working directory)" }))
});
type ShellCommandParameters = Static<typeof shellCommandParameters>;

const shellCommandTool: AgentTool<typeof shellCommandParameters, { stdout: string; stderr: string; exitCode: number }> = {
  name: "shell_command",
  label: "Execute shell command",
  description: "Executes a shell command and returns stdout, stderr, and exit code. Useful for running CLI tools like playwright-cli.",
  parameters: shellCommandParameters,
  async execute(_toolCallId: string, params: ShellCommandParameters) {
    try {
      const result = execSync(params.command, {
        cwd: params.cwd ?? process.cwd(),
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 10
      });
      return {
        content: [{ type: "text", text: result }],
        details: { stdout: result, stderr: "", exitCode: 0 }
      };
    } catch (error: any) {
      const stdout = error.stdout ?? "";
      const stderr = error.stderr ?? error.message ?? "";
      const exitCode = error.status ?? 1;
      return {
        content: [{ type: "text", text: stderr || stdout }],
        details: { stdout, stderr, exitCode }
      };
    }
  }
};

const generateMnemonicParameters = Type.Object({
  wordCount: Type.Optional(Type.Number({ description: "Number of words in the mnemonic (12 or 24). Defaults to 12." }))
});
type GenerateMnemonicParameters = Static<typeof generateMnemonicParameters>;

const generateMnemonicTool: AgentTool<typeof generateMnemonicParameters, { mnemonic: string }> = {
  name: "generate_mnemonic",
  label: "Generate Mnemonic",
  description: "Generates a random BIP39 mnemonic phrase (seed phrase) for crypto wallets.",
  parameters: generateMnemonicParameters,
  async execute(_toolCallId: string, params: GenerateMnemonicParameters) {
    const strength = params.wordCount === 24 ? 256 : 128;
    const mnemonic = bip39.generateMnemonic(strength);
    return {
      content: [{ type: "text", text: `Your generated mnemonic phrase is:\n\n${mnemonic}` }],
      details: { mnemonic }
    };
  }
};

const validateRecordingsParameters = Type.Object({});
type ValidateRecordingsParameters = Static<typeof validateRecordingsParameters>;

const validateRecordingsTool: AgentTool<typeof validateRecordingsParameters, { valid: boolean; errors: string[] }> = {
  name: "validate_recordings",
  label: "Validate recordings.json",
  description: "Validates that recordings.json has the correct schema. Each entry must have time(string), thinking(string), image(string ending with .png/.jpg). If invalid, returns specific errors.",
  parameters: validateRecordingsParameters,
  async execute(_toolCallId: string) {
    const dataPath = path.join(process.cwd(), "recordings.json");
    if (!existsSync(dataPath)) {
      return { content: [{ type: "text", text: "ERROR: recordings.json does not exist. Create it first." }], details: { valid: false, errors: ["file_not_found"] } };
    }

    let parsed: any;
    try {
      parsed = JSON.parse(readFileSync(dataPath, "utf8"));
    } catch {
      return { content: [{ type: "text", text: "ERROR: recordings.json is not valid JSON." }], details: { valid: false, errors: ["invalid_json"] } };
    }

    const errors: string[] = [];
    if (!Array.isArray(parsed)) errors.push("root must be an array");
    else {
      parsed.forEach((entry: any, i: number) => {
        if (typeof entry !== "object" || entry === null) errors.push(`item[${i}]: must be an object`);
        else {
          if (typeof entry.time !== "string") errors.push(`item[${i}].time: must be a string, got ${typeof entry.time}`);
          if (typeof entry.thinking !== "string") errors.push(`item[${i}].thinking: must be a string, got ${typeof entry.thinking}`);
          if (typeof entry.image !== "string") errors.push(`item[${i}].image: must be a string, got ${typeof entry.image}`);
          else if (!entry.image.endsWith(".png") && !entry.image.endsWith(".jpg")) errors.push(`item[${i}].image: must end with .png or .jpg`);
        }
      });
      if (parsed.length === 0) errors.push("array must have at least 1 entry");
    }

    if (errors.length > 0) {
      return { content: [{ type: "text", text: `INVALID: ${errors.join("; ")}` }], details: { valid: false, errors } };
    }
    return { content: [{ type: "text", text: `VALID: ${parsed.length} entries, all have time/thinking/image fields.` }], details: { valid: true, errors: [] } };
  }
};

// ==================== Extension Management ====================

const EXTENSION_ANALYZER_DIR = "chrome-extension-analyzer";
const AGENT_QUEUE_DIR = "agent-queue";
/** Must match oarmour-site `EXTENSION_SIDE_DATA_DIRNAME`: sidecar for cli_config, analysis, ai_testing. */
const EXTENSION_SIDE_DATA = "extension-data";
const extensionStorageRoot = process.env.EXTENSION_STORAGE_ROOT?.trim()
  ? path.resolve(process.env.EXTENSION_STORAGE_ROOT.trim())
  : os.tmpdir();
const EXTENSION_ANALYZER_ROOT = path.join(extensionStorageRoot, EXTENSION_ANALYZER_DIR);
const AGENT_QUEUE_ROOT = process.env.AGENT_QUEUE_ROOT?.trim()
  ? path.resolve(process.env.AGENT_QUEUE_ROOT.trim())
  : path.join(extensionStorageRoot, AGENT_QUEUE_DIR);
const AGENT_STATUS_PATH = path.join(AGENT_QUEUE_ROOT, "status.json");
const AGENT_DEFAULT_PROMPT_PATH = path.join(AGENT_QUEUE_ROOT, "prompt.md");

function syncAgentQueueDefaultPromptFromBundled(): void {
  if (existsSync(AGENT_DEFAULT_PROMPT_PATH)) return;
  const src = path.join(process.cwd(), "resources", "default-extension-test-prompt.md");
  if (!existsSync(src)) return;
  mkdirSync(path.dirname(AGENT_DEFAULT_PROMPT_PATH), { recursive: true });
  copyFileSync(src, AGENT_DEFAULT_PROMPT_PATH);
}

type QueueEntry = {
  id: string;
  name?: string;
  version: string;
  index?: number;
  runId?: string;
  artifactRoot?: string;
  reason?: string;
};
type QueueEntryWithIncomingTime = QueueEntry & { incoming_time?: string; time?: string };
type StatusEntry = {
  id: string;
  version: string;
  status: "pending" | "running" | "complete" | "error";
  error?: string;
  index?: number;
  runId?: string;
  status_time?: string;
  duration?: number;
  recordingsPath?: string;
};

function loadJson<T>(filePath: string, defaultValue: T): T {
  if (!existsSync(filePath)) return defaultValue;
  const content = readFileSync(filePath, "utf8").trim();
  if (!content) return defaultValue;
  return JSON.parse(content);
}

function saveJson(filePath: string, data: unknown) {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmpPath, filePath);
}

function loadStatus(): StatusEntry[] {
  return loadJson(AGENT_STATUS_PATH, []);
}

function saveStatus(status: StatusEntry[]) {
  const writablePaths = [AGENT_STATUS_PATH];
  for (const filePath of writablePaths) {
    saveJson(filePath, status);
  }
}

function calculateDurationSeconds(incomingTime?: string): number | undefined {
  if (!incomingTime) return undefined;
  const incomingMs = Date.parse(incomingTime);
  if (Number.isNaN(incomingMs)) return undefined;
  const seconds = Math.floor((Date.now() - incomingMs) / 1000);
  return Math.max(0, seconds);
}

function updateStatus(
  status: StatusEntry[],
  entry: StatusEntry,
  queueEntry?: QueueEntryWithIncomingTime
): StatusEntry[] {
  const now = new Date().toISOString();
  const incomingTime = queueEntry?.incoming_time ?? queueEntry?.time;
  const durationSeconds = calculateDurationSeconds(incomingTime);

  // Match by (id, version) AND runId (or index fallback) so that concurrent
  // runs for the same extension don't overwrite each other's status rows.
  const matchesRun = (s: StatusEntry) => {
    if (entry.runId || s.runId) return s.runId === entry.runId;
    if (entry.index !== undefined || s.index !== undefined) return s.index === entry.index;
    return true;
  };
  const idx = status.findIndex(
    (s) => s.id === entry.id && s.version === entry.version && matchesRun(s),
  );
  const nextEntry: StatusEntry = {
    ...(idx >= 0 ? status[idx] : {}),
    ...entry,
    status_time: now
  };

  if (durationSeconds !== undefined) {
    nextEntry.duration = durationSeconds;
  }
  if (queueEntry?.index !== undefined) {
    nextEntry.index = queueEntry.index;
  }
  if (queueEntry?.runId) {
    nextEntry.runId = queueEntry.runId;
  }
  const runId = queueEntry?.runId ?? (queueEntry?.index !== undefined ? String(queueEntry.index) : entry.runId);
  if (runId) {
    const ref = queueEntry ?? entry;
    nextEntry.recordingsPath = path.join(
      resolveExtensionSidecarRoot({ id: ref.id, version: ref.version }),
      "ai_testing",
      runId,
      "recordings.json"
    );
  }

  if (idx >= 0) status[idx] = nextEntry;
  else status.push(nextEntry);
  saveStatus(status);
  return status;
}

function getQueueIndex(queueEntry: QueueEntry): number {
  if (queueEntry.index !== undefined && Number.isFinite(queueEntry.index)) return queueEntry.index;
  const fromRunId = queueEntry.runId ? Date.parse(queueEntry.runId.slice(0, 8)) : NaN;
  return Number.isNaN(fromRunId) ? 0 : fromRunId;
}

function getQueueRunId(queueEntry: QueueEntry): string {
  return queueEntry.runId ?? String(getQueueIndex(queueEntry));
}

function resolveExtensionArtifactRoot(queueEntry: Pick<QueueEntry, "id" | "version" | "artifactRoot">): string {
  if (queueEntry.artifactRoot) {
    return path.resolve(queueEntry.artifactRoot);
  }
  return path.join(EXTENSION_ANALYZER_ROOT, queueEntry.id, queueEntry.version);
}

function resolveExtensionSidecarRoot(queueEntry: Pick<QueueEntry, "id" | "version">): string {
  return path.join(AGENT_QUEUE_ROOT, EXTENSION_SIDE_DATA, queueEntry.id, queueEntry.version);
}

/** Picks the newest unpacked version folder under `chrome-extension-analyzer/<id>/` by mtime. */
function resolveLatestAnalyzerVersion(extensionId: string): string | undefined {
  const base = path.join(EXTENSION_ANALYZER_ROOT, extensionId);
  if (!existsSync(base)) return undefined;
  const names = readdirSync(base);
  const dirs: { name: string; mtime: number }[] = [];
  for (const name of names) {
    const p = path.join(base, name);
    try {
      const st = statSync(p);
      if (st.isDirectory()) dirs.push({ name, mtime: st.mtimeMs });
    } catch {
      /* skip */
    }
  }
  if (dirs.length === 0) return undefined;
  dirs.sort((a, b) => b.mtime - a.mtime);
  return dirs[0].name;
}

function resolveCliConfigPath(sidecarRootDir: string): string | undefined {
  const p = path.join(sidecarRootDir, "cli_config.json");
  return existsSync(p) ? p : undefined;
}

function resolveHeadlessForDefaultCliConfig(): boolean {
  const raw = process.env.PLAYWRIGHT_CLI_HEADLESS;
  if (raw === undefined || String(raw).trim() === "") return true;
  return !/^0|false|no|off$/i.test(String(raw).trim());
}

/** Default cli_config matches known-good MetaMask setup: chromium, headless, userDataDir, no sandbox. */
function buildDefaultCliConfigPayload(extensionUnpackAbs: string, sidecarRootAbs: string) {
  const abs = path.resolve(extensionUnpackAbs);
  const sidecar = path.resolve(sidecarRootAbs);
  const userDataDir =
    process.env.PLAYWRIGHT_CLI_USER_DATA_DIR?.trim() || path.join(sidecar, ".playwright-profile");
  return {
    browser: {
      launchOptions: {
        headless: resolveHeadlessForDefaultCliConfig(),
        channel: "chromium",
        args: [
          `--load-extension=${abs}`,
          `--disable-extensions-except=${abs}`,
          "--no-sandbox",
          "--disable-setuid-sandbox"
        ]
      },
      browserName: "chromium",
      userDataDir,
      chromiumSandbox: false
    }
  };
}

function writeDefaultCliConfigIfMissing(sidecarRootDir: string, unpackRootDir: string): void {
  if (resolveCliConfigPath(sidecarRootDir)) return;
  const sidecar = path.resolve(sidecarRootDir);
  const dest = path.join(sidecar, "cli_config.json");
  const payload = buildDefaultCliConfigPayload(unpackRootDir, sidecarRootDir);
  const dir = path.dirname(dest);
  mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.cli_config.json.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  renameSync(tmpPath, dest);
  logInfo("[browseragent] wrote default cli_config.json", { dest });
}

/**
 * Prompt resolution: extension override first (`$AGENT_QUEUE_ROOT/extension-data/<id>/prompt.md`),
 * then shared `$AGENT_QUEUE_ROOT/prompt.md` (seeded from `resources/default-extension-test-prompt.md` when missing).
 */
function resolveExtensionPromptPath(queueEntry: QueueEntry): string {
  const extensionPrompt = path.join(AGENT_QUEUE_ROOT, EXTENSION_SIDE_DATA, queueEntry.id, "prompt.md");
  if (existsSync(extensionPrompt)) return extensionPrompt;
  syncAgentQueueDefaultPromptFromBundled();
  if (existsSync(AGENT_DEFAULT_PROMPT_PATH)) return AGENT_DEFAULT_PROMPT_PATH;
  throw new Error(
    `prompt.md 不存在: 扩展 ${extensionPrompt} 或全局 ${AGENT_DEFAULT_PROMPT_PATH}（可由 OArmour 同步或放置 resources/default-extension-test-prompt.md 后重启）`,
  );
}

function ensureExtensionFiles(queueEntry: QueueEntryWithIncomingTime) {
  const artifactRootDir = resolveExtensionArtifactRoot(queueEntry);
  if (!existsSync(artifactRootDir)) {
    throw new Error(`扩展目录不存在: ${artifactRootDir}`);
  }
  const sidecarRootDir = resolveExtensionSidecarRoot(queueEntry);
  mkdirSync(sidecarRootDir, { recursive: true });
  const promptPath = resolveExtensionPromptPath(queueEntry);
  writeDefaultCliConfigIfMissing(sidecarRootDir, artifactRootDir);
  const cliConfigPath = resolveCliConfigPath(sidecarRootDir);

  if (!cliConfigPath) {
    throw new Error(`cli_config.json 不存在: ${sidecarRootDir}`);
  }

  return {
    extensionRootDir: artifactRootDir,
    sidecarRootDir,
    versionDir: artifactRootDir,
    promptPath,
    cliConfigPath
  };
}

const PROFILE_LOCK_FILES = ["SingletonLock", "SingletonCookie", "SingletonSocket", "DevToolsActivePort"];

function stripShellQuotes(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parsePlaywrightProfileArg(command: string): string | undefined {
  const profileMatch = command.match(/--profile(?:=|\s+)(?:"[^"]*"|'[^']*'|\S+)/);
  if (!profileMatch) return undefined;
  const raw = profileMatch[0].replace(/^--profile(?:=|\s+)/, "").trim();
  if (!raw) return undefined;
  return stripShellQuotes(raw);
}

function cleanupProfileLocks(profileDir: string): void {
  for (const lockName of PROFILE_LOCK_FILES) {
    const lockPath = path.join(profileDir, lockName);
    if (existsSync(lockPath)) {
      rmSync(lockPath, { recursive: true, force: true });
      logInfo("[browser-guard] removed stale profile lock", { lockPath });
    }
  }
}

/** Default on: set BROWSER_GUARD_CLOSE_ALL_BEFORE_OPEN=0 to skip closing playwright-cli sessions before open. */
function browserGuardCloseAllBeforeOpen(): boolean {
  const v = process.env.BROWSER_GUARD_CLOSE_ALL_BEFORE_OPEN;
  if (v === undefined || v === "") return true;
  return !/^0|false|no|off$/i.test(v.trim());
}

/** Release playwright-cli managed browsers before a new open, reduces \"Browser is already in use\". Non-fatal on failure. */
function maybeClosePlaywrightCliSessionsBeforeOpen(shellCwd: string): void {
  if (!browserGuardCloseAllBeforeOpen()) {
    logInfo("[browser-guard] skip close-all (BROWSER_GUARD_CLOSE_ALL_BEFORE_OPEN=off)");
    return;
  }
  try {
    execSync("playwright-cli close-all", {
      cwd: shellCwd,
      encoding: "utf8",
      stdio: "pipe",
      maxBuffer: 1024 * 1024,
      timeout: 20_000
    });
    logInfo("[browser-guard] playwright-cli close-all completed");
  } catch (e: any) {
    const hint = String(e?.stderr ?? e?.stdout ?? e?.message ?? e ?? "").slice(0, 240);
    logInfo("[browser-guard] playwright-cli close-all non-fatal", { hint: hint || "(no output)" });
  }
}

function resolveProfileDirectory(profileArg: string, shellCwd: string): string {
  return path.isAbsolute(profileArg) ? path.normalize(profileArg) : path.resolve(shellCwd, profileArg);
}

// Rewrites `playwright-cli screenshot --filename=<X>` so the file always lands in
// `<sidecar>/ai_testing/<runId>/`. Without this, bare filenames resolve against
// the shell's cwd (sidecar root) and the O'Armour UI's asset route, which looks
// under `ai_testing/<runId>/`, returns 404 — producing broken thumbnails.
function applyScreenshotPathGuard(
  command: string,
  sidecarDir: string,
  runId: string,
): string {
  const screenshotRe = /(\bplaywright-cli\s+screenshot\b[^\n]*?--filename=)("([^"]+)"|'([^']+)'|(\S+))/g;
  let touched = false;
  const rewritten = command.replace(screenshotRe, (full, prefix, _arg, dq, sq, bare) => {
    const value = (dq ?? sq ?? bare ?? "").trim();
    if (!value) return full;
    if (path.isAbsolute(value)) return full;
    const basename = path.basename(value);
    if (!basename) return full;
    const newValue = `ai_testing/${runId}/${basename}`;
    touched = true;
    if (dq) return `${prefix}"${newValue}"`;
    if (sq) return `${prefix}'${newValue}'`;
    return `${prefix}${newValue}`;
  });
  if (touched) {
    const runDir = path.join(sidecarDir, "ai_testing", runId);
    if (!existsSync(runDir)) mkdirSync(runDir, { recursive: true });
    logInfo("[shot-guard] rewrote screenshot --filename", { runId });
  }
  return rewritten;
}

function applyPlaywrightOpenGuard(
  command: string,
  _unpackExtDir: string,
  sidecarDir: string,
  queueEntry: QueueEntry,
  shellCwd: string
): string {
  if (!/\bplaywright-cli\s+open\b/.test(command)) {
    return command;
  }

  const profileArg = parsePlaywrightProfileArg(command);
  if (profileArg) {
    const profileDir = resolveProfileDirectory(profileArg, shellCwd);
    cleanupProfileLocks(profileDir);
    logInfo("[browser-guard] using existing profile", { profileDir });
    return command;
  }

  const runId = getQueueRunId(queueEntry);
  const isolatedProfileDir = path.join(sidecarDir, "ai_testing", runId, ".playwright-profile");
  mkdirSync(isolatedProfileDir, { recursive: true });
  cleanupProfileLocks(isolatedProfileDir);
  logInfo("[browser-guard] isolated profile enabled", {
    profileDir: isolatedProfileDir,
    id: queueEntry.id,
    runId,
  });
  return `${command} --persistent --profile=${JSON.stringify(isolatedProfileDir)}`;
}

function createExtensionShellCommandTool(
  extDir: string,
  sidecarDir: string,
  queueEntry: QueueEntry
): AgentTool<typeof shellCommandParameters, any> {
  return {
    name: "shell_command",
    label: "Execute shell command",
    description: `Executes a shell command and returns stdout, stderr, and exit code. Default working directory: ${sidecarDir} (cli_config.json). Unpacked extension: ${extDir}.`,
    parameters: shellCommandParameters,
    async execute(_toolCallId: string, params: ShellCommandParameters) {
      const runId = getQueueRunId(queueEntry);
      if (isFinalizeRequested(runId)) {
        return {
          content: [
            {
              type: "text",
              text: "Shell commands are blocked: task timeout finalization is saving screenshots and network traffic.",
            },
          ],
          details: { stdout: "", stderr: "finalize_in_progress", exitCode: 1 },
        };
      }
      beginShellCommand(runId);
      try {
        const shellCwd = params.cwd ? path.resolve(sidecarDir, params.cwd) : sidecarDir;
        if (/\bplaywright-cli\s+open\b/.test(params.command)) {
          maybeClosePlaywrightCliSessionsBeforeOpen(shellCwd);
        }
        const guardedCommand = applyPlaywrightOpenGuard(params.command, extDir, sidecarDir, queueEntry, shellCwd);
        const finalCommand = applyScreenshotPathGuard(guardedCommand, sidecarDir, runId);
        const result = execSync(finalCommand, {
          cwd: shellCwd,
          encoding: "utf8",
          maxBuffer: 1024 * 1024 * 10,
        });
        return {
          content: [{ type: "text", text: result }],
          details: { stdout: result, stderr: "", exitCode: 0 },
        };
      } catch (error: any) {
        const stdout = error.stdout ?? "";
        const stderr = error.stderr ?? error.message ?? "";
        const exitCode = error.status ?? 1;
        return {
          content: [{ type: "text", text: stderr || stdout }],
          details: { stdout, stderr, exitCode },
        };
      } finally {
        endShellCommand(runId);
      }
    },
  };
}

const emptyToolParameters = Type.Object({});

function createStartNetworkCaptureTool(sidecarDir: string): AgentTool<typeof emptyToolParameters, any> {
  return {
    name: "start_network_capture",
    label: "Start network capture",
    description:
      "Clears the playwright-cli in-session network log. Call right after `playwright-cli open` so only traffic from this test run is saved. Capture itself uses `playwright-cli network` when you call capture_network_traffic.",
    parameters: emptyToolParameters,
    async execute() {
      try {
        clearNetworkCapture(sidecarDir);
        return {
          content: [{ type: "text", text: "Network log cleared (playwright-cli network --clear)." }],
          details: { ok: true }
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `ERROR: ${msg}` }],
          details: { ok: false, error: msg }
        };
      }
    }
  };
}

function createCaptureNetworkTrafficTool(
  sidecarDir: string,
  runId: string
): AgentTool<typeof emptyToolParameters, any> {
  return {
    name: "capture_network_traffic",
    label: "Save captured network traffic",
    description: `Runs playwright-cli network (--request-headers, https filter), saves all matching requests except chrome-extension://, writes ai_testing/${runId}/network.json. Call before validate_recordings.`,
    parameters: emptyToolParameters,
    async execute() {
      try {
        const { dest, count } = saveNetworkCapture({ sidecarDir, runId });
        return {
          content: [
            {
              type: "text",
              text: `Saved ${count} request(s) via playwright-cli network to ${dest}`
            }
          ],
          details: { dest, count, ok: true }
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `ERROR: ${msg}` }],
          details: { ok: false, error: msg }
        };
      }
    }
  };
}

function createExtensionValidateTool(sidecarDir: string, runId: string): AgentTool<typeof validateRecordingsParameters, any> {
  return {
    name: "validate_recordings",
    label: "Validate recordings.json",
    description: `Validates that recordings.json in the 'ai_testing/${runId}/' subfolder has the correct schema. Each entry must have time(string), thinking(string), image(string ending with .png/.jpg).`,
    parameters: validateRecordingsParameters,
    async execute(_toolCallId: string) {
      const dataPath = path.join(sidecarDir, "ai_testing", runId, "recordings.json");
      if (!existsSync(dataPath)) {
        return { content: [{ type: "text", text: `ERROR: ai_testing/${runId}/recordings.json does not exist. Create it first.` }], details: { valid: false, errors: ["file_not_found"] } };
      }
      let parsed: any;
      try {
        parsed = JSON.parse(readFileSync(dataPath, "utf8"));
      } catch {
        return { content: [{ type: "text", text: `ERROR: ai_testing/${runId}/recordings.json is not valid JSON.` }], details: { valid: false, errors: ["invalid_json"] } };
      }
      const errors: string[] = [];
      if (!Array.isArray(parsed)) errors.push("root must be an array");
      else {
        parsed.forEach((entry: any, i: number) => {
          if (typeof entry !== "object" || entry === null) errors.push(`item[${i}]: must be an object`);
          else {
            if (typeof entry.time !== "string") errors.push(`item[${i}].time: must be a string`);
            if (typeof entry.thinking !== "string") errors.push(`item[${i}].thinking: must be a string`);
            if (typeof entry.image !== "string") errors.push(`item[${i}].image: must be a string`);
            else if (!entry.image.endsWith(".png") && !entry.image.endsWith(".jpg")) errors.push(`item[${i}].image: must end with .png or .jpg`);
          }
        });
        if (parsed.length === 0) errors.push("array must have at least 1 entry");
      }
      if (errors.length > 0) {
        return { content: [{ type: "text", text: `INVALID: ${errors.join("; ")}` }], details: { valid: false, errors } };
      }
      return { content: [{ type: "text", text: `VALID: ${parsed.length} entries in ai_testing/${runId}/recordings.json, all have time/thinking/image fields.` }], details: { valid: true, errors: [] } };
    }
  };
}

const recordStepParameters = Type.Object({
  time: Type.String({ description: "ISO 8601 timestamp of the step, e.g. 2026-05-07T10:00:00Z" }),
  thinking: Type.String({ description: "Description of what was done in this step" }),
  image: Type.String({ description: "Screenshot filename, must end with .png or .jpg" })
});
type RecordStepParameters = Static<typeof recordStepParameters>;

function createExtensionRecordStepTool(sidecarDir: string, runId: string): AgentTool<typeof recordStepParameters, { index: number }> {
  return {
    name: "record_step",
    label: "Record operation step",
    description: `Appends a step entry to recordings.json in the 'ai_testing/${runId}/' subfolder. Screenshots will also be saved in this subfolder. Each step must have time (ISO string), thinking (description), and image (screenshot filename ending with .png/.jpg). Creates the file if it does not exist.`,
    parameters: recordStepParameters,
    async execute(_toolCallId: string, params: RecordStepParameters) {
      // Create subfolder inside ai_testing directory
      const aiTestingDir = path.join(sidecarDir, "ai_testing");
      const indexSubfolder = path.join(aiTestingDir, runId);
      if (!existsSync(indexSubfolder)) {
        execSync(`mkdir -p "${indexSubfolder}"`);
      }
      
      // Save recordings.json in the ai_testing/index subfolder
      const dataPath = path.join(indexSubfolder, "recordings.json");
      let entries: any[] = [];
      if (existsSync(dataPath)) {
        try {
          entries = JSON.parse(readFileSync(dataPath, "utf8"));
          if (!Array.isArray(entries)) entries = [];
        } catch {
          entries = [];
        }
      }
      
      let image = params.image.replace(/^\/+/, "");
      const sidecarRelativePrefix = `ai_testing/${runId}/`;
      if (image.startsWith(sidecarRelativePrefix)) {
        image = image.slice(sidecarRelativePrefix.length);
      }
      entries.push({
        time: params.time,
        thinking: params.thinking,
        image
      });
      writeFileSync(dataPath, JSON.stringify(entries, null, 2));
      return {
        content: [{ type: "text", text: `Step recorded: #${entries.length} at ${params.time}, saved to ai_testing/${runId}/recordings.json` }],
        details: { index: entries.length }
      };
    }
  };
}

async function runExtensionAgent(queueEntry: QueueEntryWithIncomingTime, runtime: RuntimeConfig) {
  const { extensionRootDir: extDir, sidecarRootDir: dataDir, promptPath } = ensureExtensionFiles(queueEntry);
  const runId = getQueueRunId(queueEntry);
  // Log the prompt.md path

  logInfo("[browseragent] using prompt.md", { promptPath, runId });

  const prompt = readFileSync(promptPath, "utf8");

  const agent = new Agent({
    initialState: {
      systemPrompt: runtime.systemPrompt,
      model: getDemoModel(runtime),
      tools: [
        getTimeTool,
        addTool,
        createExtensionShellCommandTool(extDir, dataDir, queueEntry),
        generateMnemonicTool,
        createStartNetworkCaptureTool(dataDir),
        createCaptureNetworkTrafficTool(dataDir, runId),
        createExtensionValidateTool(dataDir, runId),
        createExtensionRecordStepTool(dataDir, runId)
      ]
    },
    getApiKey: (provider: string) =>
      runtime.apiKey ?? getApiKeyForProvider(provider as KnownProvider)
  });

  let streamedText = false;
  let thinkingStreamStarted = false;
  let agentError: string | undefined;
  agent.subscribe((event: AgentEvent) => {
    // Log text streaming (Agent's response)
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      streamedText = true;
      process.stdout.write(event.assistantMessageEvent.delta);
    }
    
    // Log tool calls (when Agent decides to use a tool)
    if (agentToolLogsEnabled() && event.type === "tool_execution_start") {
      const toolName = event.toolName || "unknown";
      const toolInput = event.args || {};
      logInfo("[tool] call", {
        toolName,
        input: JSON.stringify(toolInput).substring(0, 200),
      });
    }

    // Log tool call results
    if (agentToolLogsEnabled() && event.type === "tool_execution_end") {
      const toolName = event.toolName || "unknown";
      const result = event.result;
      const resultStr = typeof result === "string" ? result : JSON.stringify(result).substring(0, 300);
      logInfo("[tool] result", { toolName, result: resultStr });
    }
    
    // Model thinking/reasoning stream (stderr; not gated by AGENT_LOG_TOOLS)
    if (
      agentThinkingLogsEnabled() &&
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "thinking_delta"
    ) {
      const delta = (event as any).assistantMessageEvent?.delta;
      if (typeof delta === "string" && delta.length > 0) {
        if (!thinkingStreamStarted) {
          process.stderr.write("\n💭 [THINKING] ");
          thinkingStreamStarted = true;
        }
        process.stderr.write(delta);
      }
    }

    // Log message completion
    if (event.type === "message_end" && (event.message as any).role === "assistant") {
      if (thinkingStreamStarted) {
        process.stderr.write("\n");
        thinkingStreamStarted = false;
      }
      if (!streamedText) {
        const blocks = (event.message as any).content as Array<any> | undefined;
        const text = (blocks ?? [])
          .filter((b) => b?.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join("");
        if (text.length > 0) {
          streamedText = true;
          process.stdout.write(text);
        }
      }
      const stopReason = (event.message as any).stopReason as string | undefined;
      const errorMessage = (event.message as any).errorMessage as string | undefined;
      if (stopReason === "error" && errorMessage) {
        agentError = errorMessage;
        logError("[browseragent] assistant message error", { error: errorMessage });
      }
    }
    
    // Log all other events for debugging (optional, can be removed later)
    if (agentDebugEventsEnabled() && event.type !== "message_update") {
      logInfo("[browseragent] event", {
        type: event.type,
        data: JSON.stringify(event).substring(0, 500),
      });
    }
  });

  await agent.prompt(prompt);
  if (agentError) {
    throw new Error(agentError);
  }
  process.stdout.write("\n");
}

async function executeRunForCoordinator(request: RunRequest): Promise<void> {
  const runtime = resolveRuntimeConfig(loadFileConfig());
  const taskTimeoutMs = resolveTaskTimeoutMs();
  const queueEntry: QueueEntryWithIncomingTime = {
    id: request.extensionId,
    version: request.version,
    runId: request.sessionId,
    index: Date.parse(request.incomingTime) || Date.now(),
    incoming_time: request.incomingTime,
    name: request.extensionName ?? undefined,
    reason: "api_dispatch"
  };

  if (isSessionCancelled(request.sessionId)) {
    updateStatus(
      loadStatus(),
      { id: request.extensionId, version: request.version, status: "error", runId: request.sessionId, index: queueEntry.index, error: "Cancelled before start" },
      queueEntry
    );
    return;
  }

  let status = loadStatus();
  status = updateStatus(
    status,
    { id: request.extensionId, version: request.version, status: "running", runId: request.sessionId, index: queueEntry.index, error: undefined },
    queueEntry
  );

  const taskLabel = `id=${request.extensionId}, runId=${request.sessionId}`;
  const sidecarDir = resolveExtensionSidecarRoot(queueEntry);
  logInfo("[browseragent] task started", {
    extensionId: request.extensionId,
    version: request.version,
    sessionId: request.sessionId,
    timeoutMs: taskTimeoutMs,
  });
  try {
    await runWithTimeoutAndFinalize(
      runExtensionAgent(queueEntry, runtime),
      taskTimeoutMs,
      taskLabel,
      { sidecarDir, runId: request.sessionId },
    );
    if (isSessionCancelled(request.sessionId)) {
      status = loadStatus();
      updateStatus(
        status,
        { id: request.extensionId, version: request.version, status: "error", runId: request.sessionId, index: queueEntry.index, error: "Cancelled by operator" },
        queueEntry
      );
      return;
    }
    status = loadStatus();
    updateStatus(
      status,
      { id: request.extensionId, version: request.version, status: "complete", runId: request.sessionId, index: queueEntry.index, error: undefined },
      queueEntry
    );
    logInfo("[browseragent] task completed", { taskLabel });
  } catch (error: any) {
    const errorMessage = error?.message ?? String(error);
    const isTimeout = typeof errorMessage === "string" && errorMessage.startsWith("Task timed out after");
    status = loadStatus();
    updateStatus(
      status,
      { id: request.extensionId, version: request.version, status: "error", runId: request.sessionId, index: queueEntry.index, error: errorMessage },
      queueEntry
    );
    if (isTimeout) {
      logError("[browseragent] task timeout", { taskLabel, timeoutMs: taskTimeoutMs });
    } else {
      logError("[browseragent] task failed", { taskLabel, error: errorMessage });
    }
  }
}

// ==================== Main ====================

const DEFAULT_TASK_TIMEOUT_MS = 10 * 60 * 1000; // 10 分钟

function resolveTaskTimeoutMs(): number {
  const raw = process.env.TASK_TIMEOUT_MS;
  if (!raw) return DEFAULT_TASK_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logWarn("[browseragent] invalid TASK_TIMEOUT_MS, using default", {
      raw,
      defaultMs: DEFAULT_TASK_TIMEOUT_MS,
    });
    return DEFAULT_TASK_TIMEOUT_MS;
  }
  return Math.floor(parsed);
}

type DirectRunCli = {
  id: string;
  version?: string;
  artifactRoot?: string;
};

type DevCliOptions = {
  /** When set, only queue entries with this extension `id` are considered. */
  extensionIdFilter?: string;
  /**
   * Run one agent session for this extension and exit (does not read `incoming_queue.json` or start file watchers).
   * Unpacked extension must exist under `$EXTENSION_STORAGE_ROOT/chrome-extension-analyzer/<id>/<version>/`.
   */
  directRun?: DirectRunCli;
};

/**
 * Parses args after `node` / script, e.g. `npm run dev -- --eid …` or `npm run dev -- --run-extension …`.
 * `--version` / `--artifact-root` apply to `--run-extension` when present (order-independent).
 */
function parseDevCliOptions(argv: string[]): DevCliOptions {
  let extensionIdFilter: string | undefined;
  let directRunId: string | undefined;
  let directRunVersion: string | undefined;
  let directRunArtifactRoot: string | undefined;
  let directRunRequested: boolean | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--eid" || a === "-eid") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        extensionIdFilter = next.trim();
        i++;
      }
      continue;
    }
    if (a.startsWith("--eid=")) {
      extensionIdFilter = a.slice("--eid=".length).trim();
      continue;
    }
    if (a === "--run-extension" || a === "--run") {
      directRunRequested = true;
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        directRunId = next.trim();
        i++;
      }
      continue;
    }
    if (a.startsWith("--run-extension=")) {
      directRunRequested = true;
      directRunId = a.slice("--run-extension=".length).trim();
      continue;
    }
    if (a.startsWith("--run=") && a !== "--run-extension" && !a.startsWith("--run-extension=")) {
      directRunRequested = true;
      directRunId = a.slice("--run=".length).trim();
      continue;
    }
    if (a === "--version") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        directRunVersion = next.trim();
        i++;
      }
      continue;
    }
    if (a.startsWith("--version=")) {
      directRunVersion = a.slice("--version=".length).trim();
      continue;
    }
    if (a === "--artifact-root") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        directRunArtifactRoot = next.trim();
        i++;
      }
      continue;
    }
    if (a.startsWith("--artifact-root=")) {
      directRunArtifactRoot = a.slice("--artifact-root=".length).trim();
    }
  }
  if (extensionIdFilter === "") extensionIdFilter = undefined;
  if (directRunId === "") directRunId = undefined;
  if (directRunVersion === "") directRunVersion = undefined;
  if (directRunArtifactRoot === "") directRunArtifactRoot = undefined;

  let directRun: DirectRunCli | undefined;
  if (directRunRequested) {
    if (!directRunId) {
      directRun = { id: "" };
    } else {
      directRun = {
        id: directRunId,
        ...(directRunVersion ? { version: directRunVersion } : {}),
        ...(directRunArtifactRoot ? { artifactRoot: path.resolve(directRunArtifactRoot) } : {})
      };
    }
  }

  return {
    ...(extensionIdFilter ? { extensionIdFilter } : {}),
    ...(directRun ? { directRun } : {})
  };
}

/** One-shot agent run: no `incoming_queue.json`, no file watchers; updates `status.json` like queue mode. */
async function runDirectExtensionOnce(
  direct: DirectRunCli,
  runtime: RuntimeConfig,
  taskTimeoutMs: number
): Promise<void> {
  if (!direct.id.trim()) {
    logError(
      "[browseragent] --run-extension requires a Chrome Web Store extension id, e.g. npm run dev -- --run-extension nkbihfbeogaeaoehlefnkodbefgpgknn",
    );
    process.exit(1);
  }
  const id = direct.id.trim();

  let version = direct.version?.trim();
  if (!version) {
    const picked = resolveLatestAnalyzerVersion(id);
    if (!picked) {
      logError("[browseragent] no unpacked extension for direct run", {
        path: path.join(EXTENSION_ANALYZER_ROOT, id),
      });
      process.exit(1);
    }
    version = picked;
    logInfo("[browseragent] direct run using latest version folder", {
      version,
      id,
      analyzerDir: `${EXTENSION_ANALYZER_DIR}/${id}/`,
    });
  }

  const index = Date.now();
  const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${id.slice(0, 8)}`;

  const queueEntry: QueueEntryWithIncomingTime = {
    id,
    version,
    index,
    runId,
    reason: "direct_cli",
    incoming_time: new Date().toISOString(),
    ...(direct.artifactRoot ? { artifactRoot: direct.artifactRoot } : {})
  };

  const unpackRoot = resolveExtensionArtifactRoot(queueEntry);
  const taskLabel = `id=${id}, runId=${runId} (direct)`;
  logInfo("[browseragent] direct extension run started", {
    taskLabel,
    unpackRoot,
    timeoutMs: taskTimeoutMs,
  });

  let status = loadStatus();
  status = updateStatus(
    status,
    { id, version, status: "running", index, runId, error: undefined },
    queueEntry
  );

  const sidecarDir = resolveExtensionSidecarRoot(queueEntry);
  try {
    await runWithTimeoutAndFinalize(
      runExtensionAgent(queueEntry, runtime),
      taskTimeoutMs,
      taskLabel,
      { sidecarDir, runId },
    );
    status = loadStatus();
    updateStatus(
      status,
      { id, version, status: "complete", index, runId, error: undefined },
      queueEntry
    );
    logInfo("[browseragent] direct run completed", { taskLabel });
    process.exit(0);
  } catch (error: any) {
    const errorMessage = error?.message ?? String(error);
    const isTimeout = typeof errorMessage === "string" && errorMessage.startsWith("Task timed out after");
    status = loadStatus();
    updateStatus(
      status,
      { id, version, status: "error", index, runId, error: errorMessage },
      queueEntry
    );
    if (isTimeout) {
      logError("[browseragent] direct run timeout", { taskLabel, timeoutMs: taskTimeoutMs });
    } else {
      logError("[browseragent] direct run failed", { taskLabel, error: errorMessage });
    }
    process.exit(1);
  }
}

async function main() {
  const runtime = resolveRuntimeConfig(loadFileConfig());
  const taskTimeoutMs = resolveTaskTimeoutMs();
  const devCli = parseDevCliOptions(process.argv.slice(2));

  if (devCli.directRun) {
    if (devCli.extensionIdFilter) {
      logInfo("[browseragent] note: --eid is ignored when --run-extension is set (direct run)");
    }
    await runDirectExtensionOnce(devCli.directRun, runtime, taskTimeoutMs);
    return;
  }

  registerRunExecutor(executeRunForCoordinator);
  const controlPlane = maybeStartControlPlaneServer();

  logInfo("[browseragent] service ready", {
    mode: "HTTP dispatch only; no local queue",
    taskTimeoutMs,
    finalizeTimeoutMs: resolveTaskFinalizeTimeoutMs(),
  });

  process.on("SIGINT", () => {
    if (controlPlane) {
      controlPlane.close(() => process.exit(0));
      return;
    }
    process.exit(0);
  });
}

await main();
