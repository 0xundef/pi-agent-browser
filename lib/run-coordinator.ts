import { logError } from "./app-logger.js";
import type { StatusEntry } from "./status-store.js";

export type RunRequest = {
  extensionId: string;
  version: string;
  sessionId: string;
  extensionName?: string | null;
  incomingTime: string;
};

export type RunExecutor = (request: RunRequest) => Promise<void>;

export type StartRunResult =
  | { ok: true }
  | { ok: false; reason: "at_capacity" | "already_running" | "not_ready" };

let executor: RunExecutor | null = null;
const activeSessionIds = new Set<string>();
const cancelledSessionIds = new Set<string>();

export function registerRunExecutor(fn: RunExecutor) {
  executor = fn;
}

export function resolveMaxConcurrentRuns(): number {
  const raw = process.env.BROWSER_AGENT_MAX_CONCURRENT?.trim() ?? process.env.MAX_CONCURRENT_RUNS?.trim();
  if (!raw) return 1;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return Math.floor(parsed);
}

export function getActiveRunCount(): number {
  return activeSessionIds.size;
}

export function isSessionCancelled(sessionId: string): boolean {
  return cancelledSessionIds.has(sessionId);
}

export async function requestStartRun(params: {
  extensionId: string;
  version: string;
  sessionId: string;
  extensionName?: string | null;
}): Promise<StartRunResult> {
  if (!executor) return { ok: false, reason: "not_ready" };

  const sessionId = params.sessionId.trim();
  const extensionId = params.extensionId.trim();
  const version = params.version.trim();
  if (!sessionId || !extensionId || !version) {
    return { ok: false, reason: "not_ready" };
  }

  if (activeSessionIds.has(sessionId)) {
    return { ok: false, reason: "already_running" };
  }

  const max = resolveMaxConcurrentRuns();
  if (activeSessionIds.size >= max) {
    return { ok: false, reason: "at_capacity" };
  }

  activeSessionIds.add(sessionId);
  cancelledSessionIds.delete(sessionId);

  const request: RunRequest = {
    extensionId,
    version,
    sessionId,
    extensionName: params.extensionName,
    incomingTime: new Date().toISOString(),
  };

  void executor(request)
    .catch((e) => {
      logError("[run] executor failed", {
        sessionId,
        error: e instanceof Error ? e.message : String(e),
      });
    })
    .finally(() => {
      activeSessionIds.delete(sessionId);
      cancelledSessionIds.delete(sessionId);
    });

  return { ok: true };
}

export function requestCancelRun(sessionId: string): "cancelled" | "not_active" {
  const trimmed = sessionId.trim();
  if (!trimmed) return "not_active";
  if (!activeSessionIds.has(trimmed)) return "not_active";
  cancelledSessionIds.add(trimmed);
  return "cancelled";
}

export function buildStatusEntryFromRequest(
  request: RunRequest,
  patch: Partial<StatusEntry>,
): StatusEntry {
  return {
    id: request.extensionId,
    version: request.version,
    runId: request.sessionId,
    index: Date.parse(request.incomingTime) || Date.now(),
    ...patch,
    status: patch.status ?? "running",
  };
}
