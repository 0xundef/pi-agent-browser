/** ISO-prefixed logs for browseragent service flows (aligned with oarmour-site lib/app-logger). */

export const nowIso = () => new Date().toISOString();

type LogSink = (message: string, payload?: unknown) => void;

let logSink: LogSink | null = null;

/** Mirror structured logs into `agent_testing.log` while a run is active. */
export function setLogSink(sink: LogSink | null): void {
  logSink = sink;
}

function formatPrefix(message: string) {
  return `${nowIso()} ${message}`;
}

function emit(level: "info" | "warn" | "error", message: string, payload?: unknown) {
  const prefix = formatPrefix(message);
  if (level === "info") {
    if (typeof payload === "undefined") console.info(prefix);
    else console.info(prefix, payload);
  } else if (level === "warn") {
    if (typeof payload === "undefined") console.warn(prefix);
    else console.warn(prefix, payload);
  } else if (typeof payload === "undefined") console.error(prefix);
  else console.error(prefix, payload);
  logSink?.(message, payload);
}

export function logInfo(message: string, payload?: unknown) {
  emit("info", message, payload);
}

export function logWarn(message: string, payload?: unknown) {
  emit("warn", message, payload);
}

export function logError(message: string, payload?: unknown) {
  emit("error", message, payload);
}
