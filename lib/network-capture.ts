import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const NETWORK_FILTER = process.env.AGENT_NETWORK_FILTER ?? "https?://";
const NETWORK_CMD = `playwright-cli network --request-headers --filter=${JSON.stringify(NETWORK_FILTER)}`;

export type NetworkRequestEntry = {
  method: string;
  url: string;
  status: number | null;
  resourceType: "fetch" | "xhr" | "websocket";
  requestedAt?: string;
  requestHeaders?: Record<string, string>;
};

export type NetworkLog = {
  capturedAt: string;
  source: "playwright-cli network";
  filter: string;
  resourceTypes: string[];
  requestCount: number;
  requests: NetworkRequestEntry[];
};

const STATIC_ASSET_RE = /\.(js|mjs|css|png|jpe?g|gif|svg|webp|woff2?|ttf|ico|map)(\?|$)/i;

function execInSidecar(sidecarDir: string, command: string): string {
  return execSync(command, {
    cwd: sidecarDir,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout: 60_000,
  });
}

function inferResourceType(entry: {
  method: string;
  url: string;
  requestHeaders?: Record<string, string>;
}): NetworkRequestEntry["resourceType"] | null {
  const url = entry.url.toLowerCase();
  if (url.startsWith("ws://") || url.startsWith("wss://")) return "websocket";

  if (STATIC_ASSET_RE.test(url)) return null;

  const accept = (entry.requestHeaders?.accept ?? entry.requestHeaders?.Accept ?? "").toLowerCase();
  const secFetchMode = (
    entry.requestHeaders?.["sec-fetch-mode"] ?? entry.requestHeaders?.["Sec-Fetch-Mode"] ?? ""
  ).toLowerCase();
  const secFetchDest = (
    entry.requestHeaders?.["sec-fetch-dest"] ?? entry.requestHeaders?.["Sec-Fetch-Dest"] ?? ""
  ).toLowerCase();

  if (secFetchMode === "websocket" || secFetchDest === "websocket") return "websocket";
  if (secFetchMode === "cors" || secFetchMode === "no-cors") return "fetch";
  if (accept.includes("application/json") || accept.includes("text/event-stream")) return "fetch";
  if (["POST", "PUT", "PATCH", "DELETE"].includes(entry.method.toUpperCase())) return "fetch";
  if (secFetchDest === "empty" || secFetchDest === "") return "fetch";
  if (/\/(api|rpc|graphql)\b|\/v[0-9]+\//i.test(url)) return "fetch";

  // Top-level document navigations (HTML) are not Fetch/XHR.
  if (
    entry.method.toUpperCase() === "GET" &&
    (accept.includes("text/html") || secFetchDest === "document")
  ) {
    return null;
  }

  return "fetch";
}

/** Parses `playwright-cli network` text output. */
export function parsePlaywrightNetworkOutput(stdout: string): NetworkRequestEntry[] {
  const lines = stdout.split("\n");
  const entries: NetworkRequestEntry[] = [];
  let current: NetworkRequestEntry | null = null;
  let inHeaders = false;

  const lineRe = /^(?:\d+\.\s+)?\[([A-Z]+)\]\s+(\S+)\s+=>\s+\[(\d+)\]\s*$/;
  const linePendingRe = /^(?:\d+\.\s+)?\[([A-Z]+)\]\s+(\S+)\s+=>\s+\[\]\s*$/;

  const pushCurrent = () => {
    if (!current) return;
    const type = inferResourceType(current);
    if (type) entries.push({ ...current, resourceType: type });
    current = null;
    inHeaders = false;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("###")) continue;

    const match = trimmed.match(lineRe);
    if (match) {
      pushCurrent();
      current = {
        method: match[1],
        url: match[2],
        status: Number(match[3]),
        resourceType: "fetch",
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
        resourceType: "fetch",
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

function runPlaywrightNetwork(sidecarDir: string): string {
  try {
    return execInSidecar(sidecarDir, NETWORK_CMD);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/unknown command:\s*network/i.test(message)) throw err;
    const fallback = `playwright-cli requests --filter=${JSON.stringify(NETWORK_FILTER)}`;
    return execInSidecar(sidecarDir, fallback);
  }
}

/** Clears the in-session network list (call after browser open). */
export function clearNetworkCapture(sidecarDir: string): void {
  try {
    execInSidecar(sidecarDir, "playwright-cli network --clear");
  } catch {
    // older CLI may not support --clear
  }
}

/** Runs `playwright-cli network` and returns Fetch/XHR + WebSocket entries. */
export function collectNetworkFromCli(sidecarDir: string): NetworkRequestEntry[] {
  const stdout = runPlaywrightNetwork(sidecarDir);
  return parsePlaywrightNetworkOutput(stdout);
}

/** Writes ai_testing/<runId>/network.json from playwright-cli network output. */
export function saveNetworkCapture(params: {
  sidecarDir: string;
  runId: string;
}): { dest: string; count: number } {
  const requests = collectNetworkFromCli(params.sidecarDir);
  const runDir = path.join(params.sidecarDir, "ai_testing", params.runId);
  mkdirSync(runDir, { recursive: true });
  const dest = path.join(runDir, "network.json");

  const log: NetworkLog = {
    capturedAt: new Date().toISOString(),
    source: "playwright-cli network",
    filter: NETWORK_FILTER,
    resourceTypes: ["fetch", "xhr", "websocket"],
    requestCount: requests.length,
    requests,
  };
  writeFileSync(dest, `${JSON.stringify(log, null, 2)}\n`, "utf8");
  return { dest, count: requests.length };
}
