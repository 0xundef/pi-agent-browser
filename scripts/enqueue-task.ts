import { logError, logInfo } from "../lib/app-logger.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const getArg = (name: string): string | undefined => {
    const key = `--${name}=`;
    const direct = args.find((arg) => arg.startsWith(key));
    if (direct) return direct.slice(key.length);
    const idx = args.findIndex((arg) => arg === `--${name}`);
    if (idx >= 0 && args[idx + 1]) return args[idx + 1];
    return undefined;
  };

  const id = getArg("id") ?? "nkbihfbeogaeaoehlefnkodbefgpgknn";
  const name = getArg("name") ?? "MetaMask";
  const version = getArg("version") ?? "12.17.3_0";
  const runId =
    getArg("run-id") ??
    getArg("session-id") ??
    `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${id.slice(0, 8)}-${version.replace(/[^a-zA-Z0-9._-]+/g, "_")}`;
  const reason = getArg("reason") ?? "manual_enqueue";

  return { id, name, version, runId, reason };
}

function resolveApiBaseUrl(): string {
  const base = process.env.BROWSER_AGENT_API_URL?.trim() ?? "http://127.0.0.1:8791";
  return base.replace(/\/+$/, "");
}

async function main() {
  const { id, name, version, runId, reason } = parseArgs();
  const base = resolveApiBaseUrl();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const apiKey = process.env.BROWSER_AGENT_API_KEY?.trim();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetch(`${base}/v1/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      extensionId: id,
      storeId: id,
      version,
      sessionId: runId,
      name,
      reason,
    }),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string; reason?: string; sessionId?: string };
  if (!res.ok) {
    const detail = json.error ?? json.reason ?? res.statusText;
    throw new Error(`Dispatch failed (${res.status}): ${detail}`);
  }

  logInfo("[browseragent] task dispatched", {
    id,
    version,
    sessionId: json.sessionId ?? runId,
  });
}

main().catch((e) => {
  logError("[browseragent] enqueue failed", {
    error: e instanceof Error ? e.message : String(e),
  });
  process.exit(1);
});
