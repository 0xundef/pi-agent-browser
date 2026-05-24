import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getStatusPath } from "./paths.js";

export type StatusEntry = {
  id: string;
  version: string;
  runId?: string;
  status: "pending" | "running" | "complete" | "error";
  error?: string;
  index?: number;
  status_time?: string;
  duration?: number;
  recordingsPath?: string;
};

export type StatusSessionView = {
  sessionId: string;
  extensionId: string;
  version: string;
  status: StatusEntry["status"];
  error?: string;
  updatedAt?: string;
  duration?: number;
};

function loadJson<T>(filePath: string, defaultValue: T): T {
  if (!existsSync(filePath)) return defaultValue;
  const content = readFileSync(filePath, "utf8").trim();
  if (!content) return defaultValue;
  return JSON.parse(content) as T;
}

function saveJson(filePath: string, data: unknown) {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmpPath, filePath);
}

export function loadStatus(): StatusEntry[] {
  return loadJson<StatusEntry[]>(getStatusPath(), []);
}

export function saveStatus(status: StatusEntry[]) {
  saveJson(getStatusPath(), status);
}

function calculateDurationSeconds(incomingTime?: string): number | undefined {
  if (!incomingTime) return undefined;
  const incomingMs = Date.parse(incomingTime);
  if (Number.isNaN(incomingMs)) return undefined;
  return Math.max(0, Math.floor((Date.now() - incomingMs) / 1000));
}

export function updateStatus(
  status: StatusEntry[],
  entry: StatusEntry,
  incomingTime?: string,
): StatusEntry[] {
  const now = new Date().toISOString();
  const durationSeconds = calculateDurationSeconds(incomingTime);
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
    status_time: now,
  };
  if (durationSeconds !== undefined) nextEntry.duration = durationSeconds;
  const next = [...status];
  if (idx >= 0) next[idx] = nextEntry;
  else next.push(nextEntry);
  saveStatus(next);
  return next;
}

export function listStatusSessions(): StatusSessionView[] {
  const rows = loadStatus();
  return rows
    .map((row) => ({
      sessionId: row.runId ?? (row.index !== undefined ? String(row.index) : ""),
      extensionId: row.id,
      version: row.version,
      status: row.status,
      error: row.error,
      updatedAt: row.status_time,
      duration: row.duration,
    }))
    .filter((row) => row.sessionId)
    .sort((a, b) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? ""));
}

export function markSessionCancelled(sessionId: string): boolean {
  const statuses = loadStatus();
  const idx = statuses.findIndex((row) => row.runId === sessionId);
  if (idx < 0) return false;
  const row = statuses[idx];
  if (row.status === "complete" || row.status === "error") return false;
  statuses[idx] = {
    ...row,
    status: "error",
    error: "Cancelled by operator",
    status_time: new Date().toISOString(),
  };
  saveStatus(statuses);
  return true;
}
