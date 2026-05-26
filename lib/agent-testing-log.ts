import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import util from "node:util";
import { nowIso } from "./app-logger.js";

const buffers = new Map<string, string[]>();
let activeRunId: string | null = null;

export function formatAgentTestingLogLine(message: string, payload?: unknown): string {
  const head = `${nowIso()} ${message}`;
  if (payload === undefined) return head;
  const inspected = util.inspect(payload, { depth: null, colors: false, compact: false });
  return inspected.includes("\n") ? `${head} ${inspected}` : `${head} ${inspected}`;
}

export function beginAgentTestingLog(runId: string): void {
  activeRunId = runId;
  buffers.set(runId, []);
}

export function endAgentTestingLog(runId?: string): void {
  if (runId) buffers.delete(runId);
  if (!runId || activeRunId === runId) activeRunId = null;
}

export function appendAgentTestingLogLine(line: string): void {
  if (!activeRunId) return;
  const buf = buffers.get(activeRunId);
  if (!buf) return;
  buf.push(line);
}

/** Agent narrative (stdout); no ISO timestamp prefix. */
export function appendAgentTestingLogText(text: string): void {
  if (!text) return;
  appendAgentTestingLogLine(text);
}

export function agentTestingLogSink(message: string, payload?: unknown): void {
  appendAgentTestingLogLine(formatAgentTestingLogLine(message, payload));
}

/** Writes `ai_testing/<runId>/agent_testing.log` next to `network.json`. */
export function flushAgentTestingLog(params: {
  sidecarDir: string;
  runId: string;
}): string {
  const lines = buffers.get(params.runId) ?? [];
  buffers.delete(params.runId);
  if (activeRunId === params.runId) activeRunId = null;

  const runDir = path.join(params.sidecarDir, "ai_testing", params.runId);
  mkdirSync(runDir, { recursive: true });
  const dest = path.join(runDir, "agent_testing.log");
  writeFileSync(dest, lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf8");
  return dest;
}
