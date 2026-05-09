import { Agent, type AgentEvent, type AgentTool } from "@mariozechner/pi-agent-core";
import { Type, getEnvApiKey, getModels, type KnownProvider, type Model, type Static } from "@mariozechner/pi-ai";
import { existsSync, readFileSync, writeFileSync, watch } from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import * as bip39 from "bip39";

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
    : [path.resolve(process.cwd(), "config.json"), path.resolve(process.cwd(), "pi-agent.config.json")].find(existsSync);

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

function resolveRuntimeConfig(fileConfig: FileConfig): RuntimeConfig {
  const configuredProvider = fileConfig.provider ?? process.env.PI_PROVIDER;
  const providers = fileConfig.providers ?? [];
  const enabledProviders = providers.filter((p) => (p.enable ?? p.enalble) === true);

  const selected =
    (configuredProvider ? enabledProviders.find((p) => p.provider === configuredProvider) : undefined) ??
    enabledProviders[0] ??
    providers[0];

  const provider = ((selected?.provider ?? configuredProvider ?? "openai") as KnownProvider) ?? "openai";
  const modelName = selected?.model ?? fileConfig.model ?? process.env.PI_MODEL ?? "gpt-4o-mini";
  const baseUrl = normalizedBaseUrl(
    selected?.baseUrl ??
      selected?.anthropicBaseUrl ??
      selected?.openaiBaseUrl ??
      fileConfig.baseUrl ??
      fileConfig.anthropicBaseUrl ??
      fileConfig.openaiBaseUrl ??
      process.env.ANTHROPIC_BASE_URL,
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

const SAMPLES_DIR = path.resolve(process.cwd(), "samples");
const EXT_LIST_PATH = path.join(SAMPLES_DIR, "ext_list.json");
const STATUS_PATH = path.join(SAMPLES_DIR, "status.json");

type ExtListEntry = { id: string; name: string; version: string; index: number };
type StatusEntry = { id: string; version: string; status: "pending" | "running" | "complete" | "error"; error?: string };

function loadJson<T>(filePath: string, defaultValue: T): T {
  if (!existsSync(filePath)) return defaultValue;
  const content = readFileSync(filePath, "utf8").trim();
  if (!content) return defaultValue;
  return JSON.parse(content);
}

function saveJson(filePath: string, data: unknown) {
  writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function loadExtList(): ExtListEntry[] {
  return loadJson(EXT_LIST_PATH, []);
}

function loadStatus(): StatusEntry[] {
  return loadJson(STATUS_PATH, []);
}

function updateStatus(status: StatusEntry[], entry: StatusEntry): StatusEntry[] {
  const idx = status.findIndex(s => s.id === entry.id);
  if (idx >= 0) status[idx] = entry;
  else status.push(entry);
  saveJson(STATUS_PATH, status);
  return status;
}

function createExtensionShellCommandTool(extDir: string): AgentTool<typeof shellCommandParameters, any> {
  return {
    name: "shell_command",
    label: "Execute shell command",
    description: `Executes a shell command and returns stdout, stderr, and exit code. Default working directory: ${extDir}`,
    parameters: shellCommandParameters,
    async execute(_toolCallId: string, params: ShellCommandParameters) {
      try {
        const result = execSync(params.command, {
          cwd: params.cwd ? path.resolve(extDir, params.cwd) : extDir,
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
}

function createExtensionValidateTool(extDir: string, extIndex: number): AgentTool<typeof validateRecordingsParameters, any> {
  return {
    name: "validate_recordings",
    label: "Validate recordings.json",
    description: `Validates that recordings.json in the 'ai_testing/${extIndex}/' subfolder has the correct schema. Each entry must have time(string), thinking(string), image(string ending with .png/.jpg).`,
    parameters: validateRecordingsParameters,
    async execute(_toolCallId: string) {
      const dataPath = path.join(extDir, "ai_testing", String(extIndex), "recordings.json");
      if (!existsSync(dataPath)) {
        return { content: [{ type: "text", text: `ERROR: ai_testing/${extIndex}/recordings.json does not exist. Create it first.` }], details: { valid: false, errors: ["file_not_found"] } };
      }
      let parsed: any;
      try {
        parsed = JSON.parse(readFileSync(dataPath, "utf8"));
      } catch {
        return { content: [{ type: "text", text: `ERROR: ai_testing/${extIndex}/recordings.json is not valid JSON.` }], details: { valid: false, errors: ["invalid_json"] } };
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
      return { content: [{ type: "text", text: `VALID: ${parsed.length} entries in ai_testing/${extIndex}/recordings.json, all have time/thinking/image fields.` }], details: { valid: true, errors: [] } };
    }
  };
}

const recordStepParameters = Type.Object({
  time: Type.String({ description: "ISO 8601 timestamp of the step, e.g. 2026-05-07T10:00:00Z" }),
  thinking: Type.String({ description: "Description of what was done in this step" }),
  image: Type.String({ description: "Screenshot filename, must end with .png or .jpg" })
});
type RecordStepParameters = Static<typeof recordStepParameters>;

function createExtensionRecordStepTool(extDir: string, extIndex: number): AgentTool<typeof recordStepParameters, { index: number }> {
  return {
    name: "record_step",
    label: "Record operation step",
    description: `Appends a step entry to recordings.json in the 'ai_testing/${extIndex}/' subfolder. Screenshots will also be saved in this subfolder. Each step must have time (ISO string), thinking (description), and image (screenshot filename ending with .png/.jpg). Creates the file if it does not exist.`,
    parameters: recordStepParameters,
    async execute(_toolCallId: string, params: RecordStepParameters) {
      // Create subfolder inside ai_testing directory
      const aiTestingDir = path.join(extDir, "ai_testing");
      const indexSubfolder = path.join(aiTestingDir, String(extIndex));
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
      
      entries.push({
        time: params.time,
        thinking: params.thinking,
        image: params.image
      });
      writeFileSync(dataPath, JSON.stringify(entries, null, 2));
      return {
        content: [{ type: "text", text: `Step recorded: #${entries.length} at ${params.time}, saved to ai_testing/${extIndex}/recordings.json` }],
        details: { index: entries.length }
      };
    }
  };
}

async function runExtensionAgent(ext: ExtListEntry, runtime: RuntimeConfig) {
  const extDir = path.join(SAMPLES_DIR, ext.id);
  const promptPath = path.join(extDir, "prompt.md");
  // Log the prompt.md path

  console.log(`Using prompt.md from ${promptPath}`);

  if (!existsSync(promptPath)) {
    throw new Error(`prompt.md not found for extension ${ext.id} at ${promptPath}`);
  }

  const prompt = readFileSync(promptPath, "utf8");

  const agent = new Agent({
    initialState: {
      systemPrompt: runtime.systemPrompt,
      model: getDemoModel(runtime),
      tools: [
        getTimeTool,
        addTool,
        createExtensionShellCommandTool(extDir),
        generateMnemonicTool,
        createExtensionValidateTool(extDir, ext.index),
        createExtensionRecordStepTool(extDir, ext.index)
      ]
    },
    getApiKey: (provider: string) =>
      runtime.apiKey ?? getApiKeyForProvider(provider as KnownProvider)
  });

  let streamedText = false;
  let agentError: string | undefined;
  agent.subscribe((event: AgentEvent) => {
    // Log text streaming (Agent's response)
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      streamedText = true;
      process.stdout.write(event.assistantMessageEvent.delta);
    }
    
    // Log tool calls (when Agent decides to use a tool)
    if (event.type === "tool_execution_start") {
      const toolName = event.toolName || "unknown";
      const toolInput = event.args || {};
      console.log(`\n🔧 [TOOL CALL] ${toolName}`);
      console.log(`   Input: ${JSON.stringify(toolInput).substring(0, 200)}`);
    }
    
    // Log tool call results
    if (event.type === "tool_execution_end") {
      const toolName = event.toolName || "unknown";
      const result = event.result;
      const resultStr = typeof result === "string" ? result : JSON.stringify(result).substring(0, 300);
      console.log(`\n✅ [TOOL RESULT] ${toolName}`);
      console.log(`   ${resultStr}`);
    }
    
    // Log thinking/reasoning events (if supported by the Agent)
    if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta") {
      const thinking = (event as any).assistantMessageEvent.delta;
      console.log(`\n💭 [THINKING] ${thinking}`);
    }
    
    // Log message completion
    if (event.type === "message_end" && (event.message as any).role === "assistant" && !streamedText) {
      const blocks = (event.message as any).content as Array<any> | undefined;
      const text = (blocks ?? [])
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("");
      if (text.length > 0) {
        streamedText = true;
        process.stdout.write(text);
      }
      const stopReason = (event.message as any).stopReason as string | undefined;
      const errorMessage = (event.message as any).errorMessage as string | undefined;
      if (stopReason === "error" && errorMessage) {
        agentError = errorMessage;
        process.stderr.write(`\n❌ Error: ${errorMessage}\n`);
      }
    }
    
    // Log all other events for debugging (optional, can be removed later)
    if (process.env.DEBUG_AGENT && event.type !== "message_update") {
      console.log(`\n📡 [EVENT] ${event.type}`);
      console.log(`   Data: ${JSON.stringify(event).substring(0, 500)}`);
    }
  });

  await agent.prompt(prompt);
  if (agentError) {
    throw new Error(agentError);
  }
  process.stdout.write("\n");
}

// ==================== Main ====================

async function main() {
  const fileConfig = loadFileConfig();
  const runtime = resolveRuntimeConfig(fileConfig);
  const provider = runtime.provider;
  const apiKey = runtime.apiKey;
  if (!apiKey) {
    process.stderr.write(
      `Missing API credentials for provider '${provider}'. Set ${envVarHintForProvider(provider)} (or configure OAuth/ADC as needed).\n`,
    );
    process.exitCode = 1;
    return;
  }

  let status = loadStatus();
  const extList = loadExtList();
  let isProcessing = false;

  // Initialize status for new extensions
  for (const ext of extList) {
    if (!status.find(s => s.id === ext.id)) {
      status = updateStatus(status, { id: ext.id, version: ext.version, status: "pending" });
    }
  }

  async function processPending() {
    if (isProcessing) {
      console.log(`[${new Date().toISOString()}] Already processing, skipping concurrent call.`);
      return;
    }
    isProcessing = true;
    try {
      const currentList = loadExtList();
      let currentStatus = loadStatus();

      for (const ext of currentList) {
        const s = currentStatus.find(s => s.id === ext.id);
        if (!s || s.status === "pending" || s.status === "error") {
          console.log(`[${new Date().toISOString()}] Processing extension: ${ext.id} (${ext.name} v${ext.version})`);
          currentStatus = updateStatus(currentStatus, { id: ext.id, version: ext.version, status: "running" });
          try {
            await runExtensionAgent(ext, runtime);
            currentStatus = loadStatus();
            updateStatus(currentStatus, { id: ext.id, version: ext.version, status: "complete" });
            console.log(`[${new Date().toISOString()}] Completed extension: ${ext.id}`);
          } catch (e: any) {
            currentStatus = loadStatus();
            updateStatus(currentStatus, { id: ext.id, version: ext.version, status: "error", error: e.message });
            console.error(`[${new Date().toISOString()}] Failed extension: ${ext.id} - ${e.message}`);
          }
        }
      }
    } finally {
      isProcessing = false;
    }
  }

  // Process existing pending extensions
  await processPending();

  // Watch for new extensions
  if (existsSync(EXT_LIST_PATH)) {
    let lastContent = readFileSync(EXT_LIST_PATH, "utf8");
    const watcher = watch(EXT_LIST_PATH, (eventType) => {
      if (eventType === "change" && existsSync(EXT_LIST_PATH)) {
        const newContent = readFileSync(EXT_LIST_PATH, "utf8");
        if (newContent !== lastContent) {
          lastContent = newContent;
          console.log(`[${new Date().toISOString()}] ext_list.json changed, processing...`);
          processPending().catch(e => console.error("Process pending failed:", e));
        }
      }
    });

    process.on("SIGINT", () => {
      watcher.close();
      process.exit(0);
    });
  }

  // Keep alive
  setInterval(() => {}, 60000);
  console.log(`[${new Date().toISOString()}] Extension monitor started. Watching ${EXT_LIST_PATH}`);
}

await main();
