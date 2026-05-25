import {
  listStatusSessions,
  markSessionCancelled,
  type StatusSessionView,
} from "./status-store.js";
import {
  getActiveRunCount,
  registerRunExecutor,
  requestCancelRun,
  requestStartRun,
  resolveMaxConcurrentRuns,
  type RunExecutor,
} from "./run-coordinator.js";

export { registerRunExecutor, type RunExecutor };

import http from "node:http";
import { logInfo } from "./app-logger.js";
import { agentDebugQueueLogsEnabled } from "./log-flags.js";
import { closeAllPlaywrightSessions, closePlaywrightSession, killAllPlaywrightSessions, listPlaywrightSessions } from "./playwright-cli-admin.js";

type JsonBody = Record<string, unknown>;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function parseJsonBody(raw: string): JsonBody {
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonBody) : {};
}

function authorize(req: http.IncomingMessage): boolean {
  const expected = process.env.BROWSER_AGENT_API_KEY?.trim();
  if (!expected) return true;
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  return token === expected;
}

function notFound(res: http.ServerResponse) {
  sendJson(res, 404, { error: "Not found" });
}

function mapSessions(rows: StatusSessionView[]) {
  return rows.map((row) => ({
    sessionId: row.sessionId,
    extensionId: row.extensionId,
    version: row.version,
    status: row.status,
    error: row.error,
    updatedAt: row.updatedAt,
    duration: row.duration,
    inQueue: false,
  }));
}

export function createControlPlaneServer() {
  return http.createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (!authorize(req)) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }

      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = url.pathname.replace(/\/+$/, "") || "/";

      if (req.method === "GET" && pathname === "/health") {
        sendJson(res, 200, {
          ok: true,
          service: "browser-agent-control-plane",
          activeRuns: getActiveRunCount(),
          maxConcurrentRuns: resolveMaxConcurrentRuns(),
        });
        return;
      }

      if (req.method === "GET" && pathname === "/v1/playwright/sessions") {
        const sessions = listPlaywrightSessions();
        sendJson(res, 200, { sessions, updatedAt: new Date().toISOString() });
        return;
      }

      if (req.method === "POST" && pathname === "/v1/playwright/sessions/kill-all") {
        const raw = await readBody(req);
        const body = parseJsonBody(raw);
        const force = body.force === true;
        closeAllPlaywrightSessions();
        if (force) killAllPlaywrightSessions();
        sendJson(res, 200, { ok: true, closedAll: true, forceKilled: force });
        return;
      }

      if (req.method === "DELETE" && pathname.startsWith("/v1/playwright/sessions/")) {
        const name = decodeURIComponent(pathname.slice("/v1/playwright/sessions/".length));
        if (!name) {
          sendJson(res, 400, { error: "session name is required" });
          return;
        }
        closePlaywrightSession(name);
        sendJson(res, 200, { ok: true, closed: name });
        return;
      }

      if (req.method === "GET" && pathname === "/v1/sessions") {
        const sessions = mapSessions(listStatusSessions());
        sendJson(res, 200, {
          sessions,
          activeRuns: getActiveRunCount(),
          maxConcurrentRuns: resolveMaxConcurrentRuns(),
          updatedAt: new Date().toISOString(),
        });
        return;
      }

      if (req.method === "POST" && pathname === "/v1/sessions") {
        const raw = await readBody(req);
        const body = parseJsonBody(raw);
        const extensionId =
          typeof body.extensionId === "string"
            ? body.extensionId.trim()
            : typeof body.storeId === "string"
              ? body.storeId.trim()
              : "";
        const version = typeof body.version === "string" ? body.version.trim() : "";
        const sessionId =
          typeof body.sessionId === "string"
            ? body.sessionId.trim()
            : typeof body.runId === "string"
              ? body.runId.trim()
              : "";
        const name = typeof body.name === "string" ? body.name.trim() : null;
        if (!extensionId || !version || !sessionId) {
          sendJson(res, 400, { error: "extensionId, version, and sessionId are required" });
          return;
        }
        const result = await requestStartRun({ extensionId, version, sessionId, extensionName: name });
        if (!result.ok) {
          if (agentDebugQueueLogsEnabled()) {
            logInfo("[control-plane] session start rejected", {
              extensionId,
              version,
              sessionId,
              reason: result.reason,
            });
          }
          const status = result.reason === "at_capacity" ? 429 : 409;
          sendJson(res, status, { ok: false, reason: result.reason });
          return;
        }
        sendJson(res, 202, {
          ok: true,
          sessionId,
          extensionId,
          version,
          status: "running",
        });
        return;
      }

      if (req.method === "DELETE" && pathname.startsWith("/v1/sessions/")) {
        const sessionId = decodeURIComponent(pathname.slice("/v1/sessions/".length));
        const cancelledActive = requestCancelRun(sessionId);
        const marked = markSessionCancelled(sessionId);
        if (cancelledActive === "not_active" && !marked) {
          sendJson(res, 404, { ok: false, reason: "not_found" });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          sessionId,
          action: cancelledActive === "cancelled" ? "cancel_requested" : "marked_cancelled",
        });
        return;
      }

      notFound(res);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      sendJson(res, 500, { error: message });
    }
  });
}

function controlPlaneEnabled(): boolean {
  const flag = process.env.BROWSER_AGENT_API_ENABLED?.trim();
  if (flag !== undefined && flag !== "" && /^0|false|no|off$/i.test(flag)) {
    return false;
  }
  return true;
}

function resolveControlPlanePort(): number | null {
  const raw = process.env.BROWSER_AGENT_API_PORT ?? "8791";
  const port = Number(raw);
  if (!Number.isFinite(port) || port <= 0) return null;
  return Math.floor(port);
}

export function startControlPlaneServer(port: number): http.Server {
  const server = createControlPlaneServer();
  server.listen(port, () => {
    logInfo("[control-plane] listening", {
      url: `http://127.0.0.1:${port}`,
      maxConcurrent: resolveMaxConcurrentRuns(),
    });
  });
  return server;
}

export function maybeStartControlPlaneServer(): http.Server | null {
  if (!controlPlaneEnabled()) {
    logInfo("[control-plane] disabled (BROWSER_AGENT_API_ENABLED=off)");
    return null;
  }
  const port = resolveControlPlanePort();
  if (port === null) {
    logInfo("[control-plane] disabled (invalid BROWSER_AGENT_API_PORT)");
    return null;
  }
  return startControlPlaneServer(port);
}
