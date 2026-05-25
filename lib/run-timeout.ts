import { logInfo, logWarn } from "./app-logger.js";
import { finalizeRunArtifactsOnTimeout } from "./run-artifacts-finalize.js";

export type RunTimeoutFinalizeContext = {
  sidecarDir: string;
  runId: string;
};

/**
 * Hard agent budget is `timeoutMs`. When it elapses, artifacts are finalized first
 * (pending screenshots, network.json), then the timeout error is thrown.
 */
export async function runWithTimeoutAndFinalize<T>(
  work: Promise<T>,
  timeoutMs: number,
  taskLabel: string,
  finalize: RunTimeoutFinalizeContext
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let rejectTimeout: ((err: Error) => void) | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
    timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await finalizeRunArtifactsOnTimeout({
            sidecarDir: finalize.sidecarDir,
            runId: finalize.runId,
          });
          logInfo("[run] timeout finalize completed", {
            taskLabel,
            networkCount: result.networkCount,
            screenshotsPresent: result.screenshots.present,
            screenshotsReferenced: result.screenshots.referenced,
            shellDrained: result.shellDrained,
            shellWaitedMs: result.shellWaitedMs,
            ...(result.errors.length ? { notes: result.errors.join("; ") } : {}),
          });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          logWarn("[run] timeout finalize failed", { taskLabel, error: message });
        }
        rejectTimeout?.(new Error(`Task timed out after ${timeoutMs}ms (${taskLabel})`));
      })();
    }, timeoutMs);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
  });

  try {
    return await Promise.race([work, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
