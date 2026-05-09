import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const samplesDir = path.join(__dirname, "samples");
const processingsDir = path.join(__dirname, "processings");
const incomingQueuePath = path.join(processingsDir, "incoming_queue.json");
const legacyQueuePath = path.join(samplesDir, "ext_list.json");
const statusPath = path.join(processingsDir, "status.json");

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
  let queueRaw: string;
  try {
    queueRaw = await readFile(incomingQueuePath, "utf8");
  } catch {
    queueRaw = await readFile(legacyQueuePath, "utf8");
  }
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
      console.log("No matching target found in processings/status.json for provided --id and --version.");
    } else {
      console.log("All status records are already synced. No update needed.");
    }
    return;
  }

  if (targetMatchedIndex === undefined) {
    console.log("Target found, but no index mapping exists in processings/incoming_queue.json.");
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

  console.log("Done. Updated exactly 1 record in processings/status.json");
  console.log(
    `Target: id=${target.id}, version=${target.version}, oldIndex=${String(previousIndex)}, newIndex=${targetMatchedIndex}`
  );
}

main().catch((error) => {
  console.error("Failed to sync index:", error);
  process.exitCode = 1;
});
