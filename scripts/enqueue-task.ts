import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

type QueueEntry = {
  id: string;
  name: string;
  version: string;
  index: number;
  incoming_time: string;
};

const SAMPLES_QUEUE_PATH = path.resolve(process.cwd(), "samples", "incoming_queue.json");
const PROCESSINGS_QUEUE_PATH = path.resolve(process.cwd(), "processings", "incoming_queue.json");

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
  writeFileSync(filePath, JSON.stringify(entries, null, 2));
}

function resolveWritableQueuePaths(): string[] {
  if (existsSync(SAMPLES_QUEUE_PATH)) return [SAMPLES_QUEUE_PATH];
  if (existsSync(PROCESSINGS_QUEUE_PATH)) return [PROCESSINGS_QUEUE_PATH];
  return [SAMPLES_QUEUE_PATH, PROCESSINGS_QUEUE_PATH];
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
  if (!Number.isFinite(index)) {
    throw new Error(`Invalid --index value: ${indexRaw}`);
  }

  return { id, name, version, index: Math.floor(index) };
}

function main() {
  const { id, name, version, index } = parseArgs();
  const entry: QueueEntry = {
    id,
    name,
    version,
    index,
    incoming_time: new Date().toISOString()
  };

  const targets = resolveWritableQueuePaths();
  for (const target of targets) {
    const queue = loadQueue(target);
    queue.push(entry);
    saveQueue(target, queue);
    console.log(`Appended queue entry to ${target}`);
  }

  console.log(`Task queued: id=${id}, version=${version}, index=${index}`);
}

main();
