import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const NETWORK_FILTER = process.env.AGENT_NETWORK_FILTER ?? "https?://";
const REQUESTS_CMD = `playwright-cli requests --filter=${JSON.stringify(NETWORK_FILTER)}`;
const LEGACY_NETWORK_CMD = `playwright-cli network --request-headers --filter=${JSON.stringify(NETWORK_FILTER)}`;

export type NetworkRequestEntry = {
  method: string;
  url: string;
  status: number | null;
  /** Optional hint for UI; not used for filtering. */
  resourceType?: "fetch" | "xhr" | "websocket";
  requestedAt?: string;
  requestHeaders?: Record<string, string>;
};

export type NetworkLog = {
  capturedAt: string;
  source: "playwright-cli requests" | "playwright-cli network";
  filter: string;
  /** Exclusions applied when saving (not playwright-cli filter). */
  resourceTypes: string[];
  requestCount: number;
  requests: NetworkRequestEntry[];
};

/** Drop extension-internal URLs only; all other playwright-cli matches are kept. */
function shouldIncludeNetworkUrl(url: string): boolean {
  return !url.toLowerCase().startsWith("chrome-extension://");
}

function execInSidecar(sidecarDir: string, command: string): string {
  return execSync(command, {
    cwd: sidecarDir,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout: 60_000,
  });
}

/** Unwrap CLI stdout (plain text, ### Result section, or JSON `{ "result": "..." }`). */
export function extractNetworkCliText(stdout: string): string {
  const trimmed = stdout.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { result?: unknown };
      if (typeof parsed.result === "string") return parsed.result;
    } catch {
      // fall through
    }
  }
  const resultSection = trimmed.match(/### Result\s*\n([\s\S]*?)(?:\n### |\n*$)/);
  if (resultSection?.[1]) return resultSection[1].trim();
  return stdout;
}

/** Parses `playwright-cli requests` / legacy `network` text output. */
export function parsePlaywrightNetworkOutput(stdout: string): NetworkRequestEntry[] {
  const text = extractNetworkCliText(stdout);
  const lines = text.split("\n");
  const entries: NetworkRequestEntry[] = [];
  let current: NetworkRequestEntry | null = null;
  let inHeaders = false;

  // Status may be `[200]` or `[200] OK` depending on playwright-cli version.
  const lineRe = /^(?:\d+\.\s+)?\[([A-Z]+)\]\s+(\S+)\s+=>\s+\[(\d+)\](?:\s+\S+)?\s*$/;
  const linePendingRe = /^(?:\d+\.\s+)?\[([A-Z]+)\]\s+(\S+)\s+=>\s+\[\]\s*$/;

  const pushCurrent = () => {
    if (!current) return;
    if (!shouldIncludeNetworkUrl(current.url)) {
      current = null;
      inHeaders = false;
      return;
    }
    const url = current.url.toLowerCase();
    const resourceType: NetworkRequestEntry["resourceType"] | undefined =
      url.startsWith("ws://") || url.startsWith("wss://") ? "websocket" : undefined;
    entries.push({ ...current, ...(resourceType ? { resourceType } : {}) });
    current = null;
    inHeaders = false;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("###")) continue;
    if (trimmed.startsWith("Note:")) continue;

    const match = trimmed.match(lineRe);
    if (match) {
      pushCurrent();
      current = {
        method: match[1],
        url: match[2],
        status: Number(match[3]),
        requestHeaders: {},
      };
      continue;
    }

    const pending = trimmed.match(linePendingRe);
    if (pending) {
      pushCurrent();
      current = {
        method: pending[1],
        url: pending[2],
        status: null,
        requestHeaders: {},
      };
      continue;
    }

    if (trimmed === "Request headers:") {
      inHeaders = true;
      continue;
    }

    if (inHeaders && current) {
      const colon = trimmed.indexOf(":");
      if (colon > 0) {
        const key = trimmed.slice(0, colon).trim();
        const value = trimmed.slice(colon + 1).trim();
        current.requestHeaders ??= {};
        current.requestHeaders[key] = value;
      }
    }
  }
  pushCurrent();
  return entries;
}

function runPlaywrightNetwork(sidecarDir: string): { stdout: string; source: NetworkLog["source"] } {
  try {
    return { stdout: execInSidecar(sidecarDir, REQUESTS_CMD), source: "playwright-cli requests" };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/unknown command:\s*requests/i.test(message)) throw err;
    return { stdout: execInSidecar(sidecarDir, LEGACY_NETWORK_CMD), source: "playwright-cli network" };
  }
}

/** Clears the in-session request list (call after browser open). */
export function clearNetworkCapture(sidecarDir: string): void {
  try {
    execInSidecar(sidecarDir, "playwright-cli requests --clear");
    return;
  } catch {
    // fall through to legacy CLI
  }
  try {
    execInSidecar(sidecarDir, "playwright-cli network --clear");
  } catch {
    // older CLI may not support --clear
  }
}

/** Runs `playwright-cli requests` and returns entries (excludes chrome-extension:// only). */
export function collectNetworkFromCli(sidecarDir: string): {
  requests: NetworkRequestEntry[];
  source: NetworkLog["source"];
} {
  const { stdout, source } = runPlaywrightNetwork(sidecarDir);
  return { requests: parsePlaywrightNetworkOutput(stdout), source };
}

/** Writes ai_testing/<runId>/network.json from playwright-cli requests output (requests may be empty). */
export function saveNetworkCapture(params: {
  sidecarDir: string;
  runId: string;
}): { dest: string; count: number } {
  const { requests, source } = collectNetworkFromCli(params.sidecarDir);
  const runDir = path.join(params.sidecarDir, "ai_testing", params.runId);
  mkdirSync(runDir, { recursive: true });
  const dest = path.join(runDir, "network.json");

  const log: NetworkLog = {
    capturedAt: new Date().toISOString(),
    source,
    filter: NETWORK_FILTER,
    resourceTypes: ["all-except-chrome-extension"],
    requestCount: requests.length,
    requests,
  };
  writeFileSync(dest, `${JSON.stringify(log, null, 2)}\n`, "utf8");
  return { dest, count: requests.length };
}
