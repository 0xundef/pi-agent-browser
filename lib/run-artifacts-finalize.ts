import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { saveNetworkCapture, type NetworkLog } from "./network-capture.js";
import {
  clearFinalizeRequested,
  getPendingShellCount,
  markFinalizeRequested,
  waitForPendingShellCommands,
} from "./run-shell-tracker.js";

const DEFAULT_FINALIZE_TIMEOUT_MS = 2 * 60 * 1000;

export function resolveTaskFinalizeTimeoutMs(): number {
  const raw = process.env.TASK_FINALIZE_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_FINALIZE_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_FINALIZE_TIMEOUT_MS;
  return Math.floor(parsed);
}

type RecordingEntry = { time?: string; thinking?: string; image?: string };

function readRecordings(runDir: string): RecordingEntry[] {
  const dataPath = path.join(runDir, "recordings.json");
  if (!existsSync(dataPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(dataPath, "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as RecordingEntry[]) : [];
  } catch {
    return [];
  }
}

/** Ensure screenshot files referenced by recordings.json exist under the run folder. */
export function syncScreenshotsFromRecordings(params: {
  sidecarDir: string;
  runId: string;
}): { referenced: number; present: number; recovered: number; missing: string[] } {
  const runDir = path.join(params.sidecarDir, "ai_testing", params.runId);
  mkdirSync(runDir, { recursive: true });
  const entries = readRecordings(runDir);
  const missing: string[] = [];
  let present = 0;
  let recovered = 0;

  for (const entry of entries) {
    const image = typeof entry.image === "string" ? entry.image.replace(/^\/+/, "") : "";
    if (!image) continue;
    const basename = path.basename(image);
    const dest = path.join(runDir, basename);
    if (existsSync(dest)) {
      present++;
      continue;
    }
    const altInRun = path.join(runDir, image);
    if (existsSync(altInRun)) {
      present++;
      continue;
    }
    const sidecarCandidate = path.join(params.sidecarDir, basename);
    if (existsSync(sidecarCandidate)) {
      copyFileSync(sidecarCandidate, dest);
      present++;
      recovered++;
      continue;
    }
    missing.push(basename);
  }

  return { referenced: entries.length, present, recovered, missing };
}

function writeEmptyNetworkJson(runDir: string, reason: string): string {
  const dest = path.join(runDir, "network.json");
  const log: NetworkLog = {
    capturedAt: new Date().toISOString(),
    source: "playwright-cli requests",
    filter: process.env.AGENT_NETWORK_FILTER ?? "https?://",
    includeStatic: true,
    capturePostDetails: true,
    resourceTypes: ["all-except-chrome-extension"],
    requestCount: 0,
    requests: [],
  };
  void reason;
  writeFileSync(dest, `${JSON.stringify(log, null, 2)}\n`, "utf8");
  return dest;
}

export type FinalizeRunArtifactsResult = {
  shellDrained: boolean;
  shellWaitedMs: number;
  pendingShellAtEnd: number;
  networkDest?: string;
  networkCount: number;
  screenshots: ReturnType<typeof syncScreenshotsFromRecordings>;
  errors: string[];
};

/**
 * On task timeout: block new shell commands, wait for in-flight screenshots,
 * sync recording images to disk, then persist network.json before reporting timeout.
 */
export async function finalizeRunArtifactsOnTimeout(params: {
  sidecarDir: string;
  runId: string;
}): Promise<FinalizeRunArtifactsResult> {
  const errors: string[] = [];
  const finalizeBudgetMs = resolveTaskFinalizeTimeoutMs();
  const runId = params.runId;

  markFinalizeRequested(runId);

  const shellWait = await waitForPendingShellCommands(runId, finalizeBudgetMs);
  if (!shellWait.drained) {
    errors.push(
      `shell commands still pending after ${shellWait.waitedMs}ms (count=${getPendingShellCount(runId)})`,
    );
  }

  const screenshots = syncScreenshotsFromRecordings({
    sidecarDir: params.sidecarDir,
    runId,
  });
  if (screenshots.missing.length > 0) {
    errors.push(`missing screenshots: ${screenshots.missing.join(", ")}`);
  }

  let networkDest: string | undefined;
  let networkCount = 0;
  try {
    const saved = saveNetworkCapture({ sidecarDir: params.sidecarDir, runId });
    networkDest = saved.dest;
    networkCount = saved.count;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push(`network capture failed: ${message}`);
    try {
      const runDir = path.join(params.sidecarDir, "ai_testing", runId);
      mkdirSync(runDir, { recursive: true });
      networkDest = writeEmptyNetworkJson(runDir, message);
    } catch (writeErr: unknown) {
      errors.push(
        `network.json fallback failed: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
      );
    }
  }

  clearFinalizeRequested(runId);

  return {
    shellDrained: shellWait.drained,
    shellWaitedMs: shellWait.waitedMs,
    pendingShellAtEnd: getPendingShellCount(runId),
    networkDest,
    networkCount,
    screenshots,
    errors,
  };
}
