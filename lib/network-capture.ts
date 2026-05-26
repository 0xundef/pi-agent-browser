import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const NETWORK_FILTER = process.env.AGENT_NETWORK_FILTER ?? "https?://";
/** playwright-cli hides successful static assets unless --static is set. */
const INCLUDE_STATIC =
  process.env.AGENT_NETWORK_INCLUDE_STATIC?.trim().toLowerCase() !== "0" &&
  process.env.AGENT_NETWORK_INCLUDE_STATIC?.trim().toLowerCase() !== "false";
const REQUESTS_CMD = `playwright-cli requests${INCLUDE_STATIC ? " --static" : ""} --filter=${JSON.stringify(NETWORK_FILTER)}`;
const LEGACY_NETWORK_CMD = `playwright-cli network --request-headers --filter=${JSON.stringify(NETWORK_FILTER)}`;

/** Default on: fetch POST request-headers + request-body at capture time. Set to 0 to disable. */
const CAPTURE_POST_DETAILS =
  process.env.AGENT_NETWORK_CAPTURE_POST_DETAILS?.trim().toLowerCase() !== "0" &&
  process.env.AGENT_NETWORK_CAPTURE_POST_DETAILS?.trim().toLowerCase() !== "false";

const POST_BODY_MAX_BYTES = Math.max(
  1024,
  Number.parseInt(process.env.AGENT_NETWORK_POST_BODY_MAX_BYTES ?? "262144", 10) || 262144,
);

const POST_ENRICH_MAX = Math.max(
  1,
  Number.parseInt(process.env.AGENT_NETWORK_POST_ENRICH_MAX ?? "200", 10) || 200,
);

export type NetworkRequestEntry = {
  method: string;
  url: string;
  status: number | null;
  /** 1-based index from `playwright-cli requests` (used for request-headers / request-body). */
  cliIndex?: number;
  /** True when playwright-cli reports `=> [FAILED]` (no HTTP response, e.g. DNS / TLS / blocked). */
  failed?: boolean;
  /** Chromium net error text when `failed` is true, e.g. `net::ERR_NAME_NOT_RESOLVED`. */
  errorText?: string;
  /** Optional hint for UI; not used for filtering. */
  resourceType?: "fetch" | "xhr" | "websocket";
  requestedAt?: string;
  requestHeaders?: Record<string, string>;
  /** POST body from `playwright-cli request-body` (null = none or not captured). */
  requestBody?: string | null;
  requestBodyTruncated?: boolean;
};

export type NetworkLog = {
  capturedAt: string;
  source: "playwright-cli requests" | "playwright-cli network";
  filter: string;
  includeStatic: boolean;
  capturePostDetails: boolean;
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

function splitNumberedLine(trimmed: string): { cliIndex?: number; rest: string } {
  const numbered = trimmed.match(/^(\d+)\.\s+(.*)$/);
  if (numbered) return { cliIndex: Number(numbered[1]), rest: numbered[2]! };
  return { rest: trimmed };
}

export function parseHeaderBlock(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("###")) continue;
    const colon = trimmed.indexOf(":");
    if (colon <= 0) continue;
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    if (key) headers[key] = value;
  }
  return headers;
}

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes) {
    end -= 1;
  }
  return { text: `${text.slice(0, end)}\n...[truncated]`, truncated: true };
}

/** Parses `playwright-cli requests` / legacy `network` text output. */
export function parsePlaywrightNetworkOutput(stdout: string): NetworkRequestEntry[] {
  const text = extractNetworkCliText(stdout);
  const lines = text.split("\n");
  const entries: NetworkRequestEntry[] = [];
  let active: NetworkRequestEntry | null = null;
  let autoIndex = 0;

  const lineRe = /^\[([A-Z]+)\]\s+(.+?)\s+=>\s+\[(\d+)\](?:\s+\S+)?\s*$/;
  const linePendingRe = /^\[([A-Z]+)\]\s+(.+?)\s+=>\s+\[\]\s*$/;
  const lineFailedRe = /^\[([A-Z]+)\]\s+(.+?)\s+=>\s+\[FAILED\]\s+(.+)\s*$/;
  const lineInFlightRe = /^\[([A-Z]+)\]\s+(.+?)\s*$/;

  const pushCurrent = () => {
    if (!active) return;
    if (!shouldIncludeNetworkUrl(active.url)) {
      active = null;
      return;
    }
    const url = active.url.toLowerCase();
    const resourceType: NetworkRequestEntry["resourceType"] | undefined =
      url.startsWith("ws://") || url.startsWith("wss://") ? "websocket" : undefined;
    entries.push({ ...active, ...(resourceType ? { resourceType } : {}) });
    active = null;
  };

  const beginEntry = (fields: {
    cliIndex?: number;
    method: string;
    url: string;
    status: number | null;
    failed?: boolean;
    errorText?: string;
  }) => {
    pushCurrent();
    autoIndex += 1;
    active = {
      ...fields,
      cliIndex: fields.cliIndex ?? autoIndex,
    };
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("###")) continue;
    if (trimmed.startsWith("Note:")) continue;

    const { cliIndex, rest } = splitNumberedLine(trimmed);

    const match = rest.match(lineRe);
    if (match) {
      beginEntry({
        cliIndex,
        method: match[1],
        url: match[2].trim(),
        status: Number(match[3]),
      });
      continue;
    }

    const pending = rest.match(linePendingRe);
    if (pending) {
      beginEntry({
        cliIndex,
        method: pending[1],
        url: pending[2].trim(),
        status: null,
      });
      continue;
    }

    const failed = rest.match(lineFailedRe);
    if (failed) {
      beginEntry({
        cliIndex,
        method: failed[1],
        url: failed[2].trim(),
        status: null,
        failed: true,
        errorText: failed[3].trim(),
      });
      continue;
    }

    const inFlight = rest.match(lineInFlightRe);
    if (inFlight && !rest.includes("=>")) {
      beginEntry({
        cliIndex,
        method: inFlight[1],
        url: inFlight[2].trim(),
        status: null,
      });
      continue;
    }

  }
  pushCurrent();
  return entries;
}

function runPlaywrightCli(sidecarDir: string, command: string): string | null {
  try {
    return execInSidecar(sidecarDir, command);
  } catch {
    return null;
  }
}

/** For each POST, run `request-headers` and `request-body` (includes failed POSTs). */
export function enrichPostRequestDetails(
  sidecarDir: string,
  requests: NetworkRequestEntry[],
): { enriched: number; skippedCap: number } {
  if (!CAPTURE_POST_DETAILS) return { enriched: 0, skippedCap: 0 };

  let enriched = 0;
  let skippedCap = 0;

  for (const req of requests) {
    if (req.method.toUpperCase() !== "POST" || req.cliIndex == null) continue;
    if (enriched >= POST_ENRICH_MAX) {
      skippedCap += 1;
      continue;
    }

    const idx = req.cliIndex;

    const headersOut = runPlaywrightCli(sidecarDir, `playwright-cli request-headers ${idx}`);
    if (headersOut) {
      const parsed = parseHeaderBlock(extractNetworkCliText(headersOut));
      if (Object.keys(parsed).length > 0) {
        req.requestHeaders = parsed;
      }
    }

    const bodyOut = runPlaywrightCli(sidecarDir, `playwright-cli request-body ${idx}`);
    if (bodyOut === null) {
      req.requestBody = null;
    } else {
      const body = extractNetworkCliText(bodyOut).trim();
      if (!body) {
        req.requestBody = null;
      } else {
        const { text, truncated } = truncateUtf8(body, POST_BODY_MAX_BYTES);
        req.requestBody = text;
        if (truncated) req.requestBodyTruncated = true;
      }
    }

    enriched += 1;
  }

  return { enriched, skippedCap };
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
  const requests = parsePlaywrightNetworkOutput(stdout);
  enrichPostRequestDetails(sidecarDir, requests);
  return { requests, source };
}

/** Writes ai_testing/<runId>/network.json from playwright-cli requests output (requests may be empty). */
export function saveNetworkCapture(params: {
  sidecarDir: string;
  runId: string;
}): { dest: string; count: number; postEnriched: number } {
  const { stdout, source } = runPlaywrightNetwork(params.sidecarDir);
  const requests = parsePlaywrightNetworkOutput(stdout);
  const { enriched: postEnriched } = enrichPostRequestDetails(params.sidecarDir, requests);
  const runDir = path.join(params.sidecarDir, "ai_testing", params.runId);
  mkdirSync(runDir, { recursive: true });
  const dest = path.join(runDir, "network.json");
  const rawDest = path.join(runDir, "network-cli-raw.txt");
  writeFileSync(rawDest, `${extractNetworkCliText(stdout)}\n`, "utf8");

  const log: NetworkLog = {
    capturedAt: new Date().toISOString(),
    source,
    filter: NETWORK_FILTER,
    includeStatic: INCLUDE_STATIC,
    capturePostDetails: CAPTURE_POST_DETAILS,
    resourceTypes: ["all-except-chrome-extension"],
    requestCount: requests.length,
    requests,
  };
  writeFileSync(dest, `${JSON.stringify(log, null, 2)}\n`, "utf8");
  return { dest, count: requests.length, postEnriched };
}
