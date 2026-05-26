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

function mapSessionRow(row: unknown): PlaywrightCliSession | null {
  if (typeof row === "string") {
    const name = row.trim();
    return name ? { name } : null;
  }
  if (!row || typeof row !== "object") return null;
  const record = row as Record<string, unknown>;
  const name =
    (typeof record.name === "string" && record.name.trim()) ||
    (typeof record.session === "string" && record.session.trim()) ||
    "";
  if (!name) return null;
  return { name, ...record };
}

/** `playwright-cli list --json` returns `{ browsers: [...] }` (not `sessions`). */
function parsePlaywrightListJson(parsed: unknown): PlaywrightCliSession[] {
  if (Array.isArray(parsed)) {
    return parsed.flatMap((row) => {
      const mapped = mapSessionRow(row);
      return mapped ? [mapped] : [];
    });
  }
  if (!parsed || typeof parsed !== "object") return [];
  const root = parsed as Record<string, unknown>;

  if (Array.isArray(root.sessions)) {
    return root.sessions.flatMap((row) => {
      const mapped = mapSessionRow(row);
      return mapped ? [mapped] : [];
    });
  }

  if (Array.isArray(root.browsers)) {
    return root.browsers.flatMap((row) => {
      const mapped = mapSessionRow(row);
      return mapped ? [mapped] : [];
    });
  }

  if (root.browsers && typeof root.browsers === "object" && !Array.isArray(root.browsers)) {
    return Object.entries(root.browsers as Record<string, unknown>).flatMap(([name, details]) => {
      const trimmed = name.trim();
      if (!trimmed) return [];
      if (details && typeof details === "object") {
        return [{ name: trimmed, ...(details as Record<string, unknown>) }];
      }
      return [{ name: trimmed }];
    });
  }

  return [];
}

/** Fallback when `--json` is empty but plain `list` shows open browsers. */
function parsePlaywrightListText(stdout: string): PlaywrightCliSession[] {
  const sessions: PlaywrightCliSession[] = [];
  let current: PlaywrightCliSession | null = null;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    const nameMatch = /^- ([^:]+):?\s*$/.exec(trimmed);
    if (nameMatch) {
      if (current) sessions.push(current);
      current = { name: nameMatch[1]!.trim() };
      continue;
    }
    const statusMatch = /^- status:\s*(\S+)/i.exec(trimmed);
    if (statusMatch && current) {
      current.status = statusMatch[1]!.toLowerCase();
    }
  }
  if (current) sessions.push(current);
  return sessions;
}

function isOpenPlaywrightSession(session: PlaywrightCliSession): boolean {
  const status = typeof session.status === "string" ? session.status.toLowerCase() : "";
  return !status || status === "open";
}

export function listPlaywrightSessions(): PlaywrightCliSession[] {
  const { stdout: jsonStdout } = runPlaywrightCli("list --json");
  const trimmed = jsonStdout.trim();
  let sessions: PlaywrightCliSession[] = [];
  if (trimmed) {
    try {
      sessions = parsePlaywrightListJson(JSON.parse(trimmed) as unknown);
    } catch {
      sessions = [];
    }
  }

  if (sessions.length === 0) {
    const { stdout: textStdout } = runPlaywrightCli("list");
    sessions = parsePlaywrightListText(textStdout);
  }

  return sessions.filter(isOpenPlaywrightSession);
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
