import { createHash } from 'node:crypto';
import { sha256Pattern } from './release-tags.mjs';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const runtimes = ['codex', 'claude', 'cursor', 'workbuddy', 'qoder', 'kimi', 'gemini', 'grok', 'opencode', 'pi'];

export function verifyTargetReceipt(receipt, entry) {
  const sourceID = `${entry.sourceCommit}:${entry.packagePath}`;
  if (receipt.schemaVersion !== 1 || receipt.sourceID !== sourceID || receipt.name !== entry.name ||
      receipt.version !== entry.version || !sha256Pattern.test(receipt.sourceDigest) ||
      !Array.isArray(receipt.artifacts) || receipt.artifacts.length !== runtimes.length) {
    throw new Error(`packager source binding mismatch: ${entry.key}`);
  }
  const seen = new Set();
  for (const artifact of receipt.artifacts) {
    const name = `${entry.key}-${artifact.runtime}`;
    if (!runtimes.includes(artifact.runtime) || seen.has(artifact.runtime) ||
        artifact.directory !== name || artifact.archive !== `${name}.zip` ||
        !sha256Pattern.test(artifact.archiveSHA256) || !sha256Pattern.test(artifact.contentDigest)) {
      throw new Error(`invalid or duplicate target artifact: ${entry.key}/${artifact.runtime}`);
    }
    seen.add(artifact.runtime);
  }
}
