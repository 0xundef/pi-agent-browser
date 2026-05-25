/** Tracks in-flight shell_command executions per run so timeout can wait for screenshots. */

const pendingByRun = new Map<string, number>();
const finalizeRequested = new Set<string>();

export function markFinalizeRequested(runId: string): void {
  finalizeRequested.add(runId);
}

export function isFinalizeRequested(runId: string): boolean {
  return finalizeRequested.has(runId);
}

export function clearFinalizeRequested(runId: string): void {
  finalizeRequested.delete(runId);
}

export function beginShellCommand(runId: string): void {
  pendingByRun.set(runId, (pendingByRun.get(runId) ?? 0) + 1);
}

export function endShellCommand(runId: string): void {
  const next = (pendingByRun.get(runId) ?? 1) - 1;
  if (next <= 0) pendingByRun.delete(runId);
  else pendingByRun.set(runId, next);
}

export function getPendingShellCount(runId: string): number {
  return pendingByRun.get(runId) ?? 0;
}

export async function waitForPendingShellCommands(
  runId: string,
  maxWaitMs: number,
  pollMs = 200
): Promise<{ drained: boolean; waitedMs: number }> {
  const start = Date.now();
  while (getPendingShellCount(runId) > 0) {
    if (Date.now() - start >= maxWaitMs) {
      return { drained: false, waitedMs: Date.now() - start };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { drained: true, waitedMs: Date.now() - start };
}
