import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export type NetworkRequestEntry = {
  method: string;
  url: string;
  status: number | null;
  requestHeaders?: Record<string, string>;
};

export type NetworkLog = {
  capturedAt: string;
  filter: string;
  requestCount: number;
  requests: NetworkRequestEntry[];
};

const REQUEST_LINE_RE = /^\[(\w+)\]\s+(.+?)\s+=>\s+\[(\d*)\]\s*$/;

function parseHeaderBlock(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    out[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return out;
}

/** Parses `playwright-cli network` text output into structured entries. */
export function parsePlaywrightNetworkOutput(raw: string): NetworkRequestEntry[] {
  const requests: NetworkRequestEntry[] = [];
  let current: NetworkRequestEntry | null = null;
  let inHeaders = false;
  const headerLines: string[] = [];

  const flushCurrent = () => {
    if (!current) return;
    if (inHeaders && headerLines.length > 0) {
      current.requestHeaders = parseHeaderBlock(headerLines);
    }
    requests.push(current);
    current = null;
    inHeaders = false;
    headerLines.length = 0;
  };

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (inHeaders && headerLines.length > 0 && current) {
        current.requestHeaders = parseHeaderBlock(headerLines);
        headerLines.length = 0;
        inHeaders = false;
      }
      continue;
    }

    const match = REQUEST_LINE_RE.exec(trimmed);
    if (match) {
      flushCurrent();
      const statusRaw = match[3];
      current = {
        method: match[1].toUpperCase(),
        url: match[2].trim(),
        status: statusRaw ? Number(statusRaw) : null,
      };
      continue;
    }

    if (trimmed === "Request headers:" && current) {
      inHeaders = true;
      continue;
    }

    if (inHeaders && current && trimmed.includes(":")) {
      headerLines.push(trimmed);
    }
  }

  flushCurrent();
  return requests;
}

/**
 * Runs `playwright-cli network` and writes `ai_testing/<runId>/network.json` under the sidecar.
 * Non-fatal on failure (logs and returns null).
 */
export function captureNetworkLog(params: {
  sidecarDir: string;
  runId: string;
  filter?: string;
}): string | null {
  const filter =
    params.filter?.trim() ||
    process.env.AGENT_NETWORK_FILTER?.trim() ||
    "https?://";
  const runDir = path.join(params.sidecarDir, "ai_testing", params.runId);
  mkdirSync(runDir, { recursive: true });
  const dest = path.join(runDir, "network.json");

  try {
    const raw = execSync(
      `playwright-cli network --request-headers --filter=${JSON.stringify(filter)}`,
      {
        cwd: params.sidecarDir,
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
        timeout: 60_000,
      }
    );
    const requests = parsePlaywrightNetworkOutput(raw);
    const log: NetworkLog = {
      capturedAt: new Date().toISOString(),
      filter,
      requestCount: requests.length,
      requests,
    };
    writeFileSync(dest, `${JSON.stringify(log, null, 2)}\n`, "utf8");
    console.log(
      `[${new Date().toISOString()}] [network] saved ${requests.length} request(s) to ${dest}`
    );
    return dest;
  } catch (e: unknown) {
    const err = e as { stderr?: string; message?: string };
    const hint = String(err.stderr ?? err.message ?? e).slice(0, 300);
    console.log(
      `[${new Date().toISOString()}] [network] capture non-fatal: ${hint || "(no output)"}`
    );
    return null;
  }
}
