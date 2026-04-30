import { Agent, type AgentEvent, type AgentTool } from "@mariozechner/pi-agent-core";
import { Type, getEnvApiKey, getModels, type KnownProvider, type Model, type Static } from "@mariozechner/pi-ai";
import { existsSync, readFileSync } from "node:fs";
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
    : path.resolve(process.cwd(), "pi-agent.config.json");

  if (!existsSync(configPath)) {
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

  const agent = new Agent({
    initialState: {
      systemPrompt: runtime.systemPrompt,
      model: getDemoModel(runtime),
      tools: [getTimeTool, addTool, shellCommandTool, generateMnemonicTool]
    },
    getApiKey: (provider: string) =>
      runtime.apiKey ?? getApiKeyForProvider(provider as KnownProvider)
  });

  let streamedText = false;
  agent.subscribe((event: AgentEvent) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      streamedText = true;
      process.stdout.write(event.assistantMessageEvent.delta);
    }

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
        process.stderr.write(`\nError: ${errorMessage}\n`);
      }
    }
  });

const prompt = `Execute the following operations using the shell_command tool, each page changed should be screenshot:

1. Run: playwright-cli open --config=.playwright/cli.config.json --headed
2. activate the MetaMask extension in the browser window
3. assume you are a metamask user and log in with your mnemonic phrase

If any step fails, check the error message and try again. Use playwright-cli --help if needed.`;
  const input =
    prompt.length > 0
      ? prompt
      : "What time is it in UTC right now? Use the get_time tool. Also add 123 and 456 using the add tool.";

  await agent.prompt(input);
  process.stdout.write("\n");
}

await main();
