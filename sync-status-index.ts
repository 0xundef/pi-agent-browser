import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { logError, logInfo } from "./lib/app-logger.js";

type QueueItem = {
  id: string;
  version: string;
  index: number;
};

type StatusItem = {
  id: string;
  version: string;
  status: string;
  index?: number;
};

const storageRoot = process.env.EXTENSION_STORAGE_ROOT?.trim()
  ? path.resolve(process.env.EXTENSION_STORAGE_ROOT.trim())
  : os.tmpdir();
const agentQueueRoot = process.env.AGENT_QUEUE_ROOT?.trim()
  ? path.resolve(process.env.AGENT_QUEUE_ROOT.trim())
  : path.join(storageRoot, "agent-queue");
const incomingQueuePath = path.join(agentQueueRoot, "incoming_queue.json");
const statusPath = path.join(agentQueueRoot, "status.json");

function buildKey(id: string, version: string): string {
  return `${id}@@${version}`;
}

function getArgValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) {
    return undefined;
  }
  return process.argv[idx + 1];
}

function parseArgs() {
  const id = getArgValue("--id");
  const version = getArgValue("--version");
  return { id, version };
}

async function main() {
  const queueRaw = await readFile(incomingQueuePath, "utf8");
  const statusRaw = await readFile(statusPath, "utf8");

  const incomingQueue = JSON.parse(queueRaw) as QueueItem[];
  const statusList = JSON.parse(statusRaw) as StatusItem[];
  const args = parseArgs();

  const maxIndexMap = new Map<string, number>();
  for (const item of incomingQueue) {
    const key = buildKey(item.id, item.version);
    const current = maxIndexMap.get(key);
    if (current === undefined || item.index > current) {
      maxIndexMap.set(key, item.index);
    }
  }

  let targetIndex = -1;
  let targetMatchedIndex: number | undefined;

  if (args.id && args.version) {
    targetIndex = statusList.findIndex(
      (item) => item.id === args.id && item.version === args.version
    );
    if (targetIndex !== -1) {
      targetMatchedIndex = maxIndexMap.get(buildKey(args.id, args.version));
    }
  } else {
    for (let i = 0; i < statusList.length; i += 1) {
      const item = statusList[i];
      const matchedIndex = maxIndexMap.get(buildKey(item.id, item.version));
      if (matchedIndex === undefined) {
        continue;
      }
      if (item.index !== matchedIndex) {
        targetIndex = i;
        targetMatchedIndex = matchedIndex;
        break;
      }
    }
  }

  if (targetIndex === -1) {
    if (args.id || args.version) {
      logInfo("[browseragent] sync-status-index: no matching target", { id: args.id, version: args.version });
    } else {
      logInfo("[browseragent] sync-status-index: all records already synced");
    }
    return;
  }

  if (targetMatchedIndex === undefined) {
    logInfo("[browseragent] sync-status-index: target found but no index mapping in incoming_queue.json");
    return;
  }

  const target = statusList[targetIndex];
  const previousIndex = target.index;
  const nextStatus = [...statusList];
  nextStatus[targetIndex] = {
    ...target,
    index: targetMatchedIndex
  };

  await writeFile(statusPath, `${JSON.stringify(nextStatus, null, 2)}\n`, "utf8");

  logInfo("[browseragent] sync-status-index: updated one record", {
    id: target.id,
    version: target.version,
    oldIndex: previousIndex,
    newIndex: targetMatchedIndex,
  });
}

main().catch((error) => {
  logError("[browseragent] sync-status-index failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
