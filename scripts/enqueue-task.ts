import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

type QueueEntry = {
  id: string;
  name?: string;
  version: string;
  index: number;
  runId: string;
  artifactRoot: string;
  reason: string;
  incoming_time: string;
};

const storageRoot = process.env.EXTENSION_STORAGE_ROOT?.trim()
  ? path.resolve(process.env.EXTENSION_STORAGE_ROOT.trim())
  : os.tmpdir();
const analyzerRoot = path.join(storageRoot, "chrome-extension-analyzer");
const agentQueueRoot = process.env.AGENT_QUEUE_ROOT?.trim()
  ? path.resolve(process.env.AGENT_QUEUE_ROOT.trim())
  : path.join(storageRoot, "agent-queue");
const AGENT_QUEUE_PATH = path.join(agentQueueRoot, "incoming_queue.json");

function loadQueue(filePath: string): QueueEntry[] {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, "utf8").trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveQueue(filePath: string, entries: QueueEntry[]) {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmpPath, `${JSON.stringify(entries, null, 2)}\n`);
  renameSync(tmpPath, filePath);
}

function resolveWritableQueuePaths(): string[] {
  return [AGENT_QUEUE_PATH];
}

function parseArgs() {
  const args = process.argv.slice(2);
  const getArg = (name: string): string | undefined => {
    const key = `--${name}=`;
    const direct = args.find((arg) => arg.startsWith(key));
    if (direct) return direct.slice(key.length);
    const idx = args.findIndex((arg) => arg === `--${name}`);
    if (idx >= 0 && args[idx + 1]) return args[idx + 1];
    return undefined;
  };

  const id = getArg("id") ?? "nkbihfbeogaeaoehlefnkodbefgpgknn";
  const name = getArg("name") ?? "MetaMask";
  const version = getArg("version") ?? "12.17.3_0";
  const indexRaw = getArg("index");
  const index = indexRaw ? Number(indexRaw) : Date.now();
  const runId = getArg("run-id") ?? `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${id.slice(0, 8)}`;
  const artifactRoot = getArg("artifact-root") ?? path.join(analyzerRoot, id, version);
  const reason = getArg("reason") ?? "manual_enqueue";
  if (!Number.isFinite(index)) {
    throw new Error(`Invalid --index value: ${indexRaw}`);
  }

  return { id, name, version, index: Math.floor(index), runId, artifactRoot, reason };
}

function main() {
  const { id, name, version, index, runId, artifactRoot, reason } = parseArgs();
  const entry: QueueEntry = {
    id,
    name,
    version,
    index,
    runId,
    artifactRoot,
    reason,
    incoming_time: new Date().toISOString()
  };

  const targets = resolveWritableQueuePaths();
  for (const target of targets) {
    const queue = loadQueue(target);
    queue.push(entry);
    saveQueue(target, queue);
    console.log(`Appended queue entry to ${target}`);
  }

  console.log(`Task queued: id=${id}, version=${version}, runId=${runId}`);
}

main();
