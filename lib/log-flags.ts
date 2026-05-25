function envFlagEnabled(raw: string | undefined, defaultWhenUnset: boolean): boolean {
  if (raw === undefined || String(raw).trim() === "") return defaultWhenUnset;
  return !/^0|false|no|off$/i.test(String(raw).trim());
}

/** Tool I/O banners. Set `AGENT_LOG_TOOLS=0` to hide [tool] call/result lines. */
export function agentToolLogsEnabled(): boolean {
  return envFlagEnabled(process.env.AGENT_LOG_TOOLS, true);
}

/** Model thinking stream on stderr. Set `AGENT_LOG_THINKING=0` to hide. */
export function agentThinkingLogsEnabled(): boolean {
  return envFlagEnabled(process.env.AGENT_LOG_THINKING, true);
}

/** Dispatch rejections (at capacity / already running). Set `AGENT_DEBUG_QUEUE=1` to enable. */
export function agentDebugQueueLogsEnabled(): boolean {
  return envFlagEnabled(process.env.AGENT_DEBUG_QUEUE, false);
}

/** Verbose agent event stream. Set `DEBUG_AGENT=1` to enable. */
export function agentDebugEventsEnabled(): boolean {
  return envFlagEnabled(process.env.DEBUG_AGENT, false);
}
