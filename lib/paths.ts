import os from "node:os";
import path from "node:path";

const EXTENSION_ANALYZER_DIR = "chrome-extension-analyzer";
const AGENT_QUEUE_DIR = "agent-queue";
export const EXTENSION_SIDE_DATA = "extension-data";

export function getExtensionStorageRoot(): string {
  const configured = process.env.EXTENSION_STORAGE_ROOT?.trim();
  return configured ? path.resolve(configured) : os.tmpdir();
}

export function getAgentQueueRoot(): string {
  const configured = process.env.AGENT_QUEUE_ROOT?.trim();
  return configured ? path.resolve(configured) : path.join(getExtensionStorageRoot(), AGENT_QUEUE_DIR);
}

export function getExtensionAnalyzerRoot(): string {
  return path.join(getExtensionStorageRoot(), EXTENSION_ANALYZER_DIR);
}

export function getStatusPath(): string {
  return path.join(getAgentQueueRoot(), "status.json");
}

export function getDefaultPromptPath(): string {
  return path.join(getAgentQueueRoot(), "prompt.md");
}

export function getExtensionScopedPromptPath(storeId: string): string {
  return path.join(getAgentQueueRoot(), EXTENSION_SIDE_DATA, storeId, "prompt.md");
}

export function getExtensionArtifactRoot(storeId: string, version: string): string {
  return path.join(getExtensionAnalyzerRoot(), storeId, version);
}
