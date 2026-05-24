import { execSync } from "node:child_process";

export type PlaywrightCliSession = {
  name: string;
  [key: string]: unknown;
};

function runPlaywrightCli(args: string, timeoutMs = 30_000): { stdout: string; stderr: string } {
  try {
    const stdout = execSync(`playwright-cli ${args}`, {
      encoding: "utf8",
      stdio: "pipe",
      maxBuffer: 4 * 1024 * 1024,
      timeout: timeoutMs,
    });
    return { stdout: String(stdout ?? ""), stderr: "" };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const message = String(err?.stderr ?? err?.stdout ?? err?.message ?? e ?? "");
    throw new Error(message.trim() || "playwright-cli command failed");
  }
}

export function listPlaywrightSessions(): PlaywrightCliSession[] {
  const { stdout } = runPlaywrightCli("list --json");
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed) as unknown;
  if (Array.isArray(parsed)) {
    return parsed.map((row) => {
      if (typeof row === "string") return { name: row };
      if (row && typeof row === "object" && "name" in row) {
        return row as PlaywrightCliSession;
      }
      return { name: String(row) };
    });
  }
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { sessions?: unknown }).sessions)) {
    return ((parsed as { sessions: PlaywrightCliSession[] }).sessions ?? []).map((s) =>
      typeof s === "string" ? { name: s } : s,
    );
  }
  return [];
}

export function closePlaywrightSession(name: string): void {
  const safe = name.trim();
  if (!safe) throw new Error("session name is required");
  runPlaywrightCli(`-s=${JSON.stringify(safe)} close`);
}

export function closeAllPlaywrightSessions(): void {
  runPlaywrightCli("close-all", 60_000);
}

export function killAllPlaywrightSessions(): void {
  runPlaywrightCli("kill-all", 60_000);
}
