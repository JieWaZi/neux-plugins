import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCatalog } from './build-catalog.mjs';
import { GitHubReleases } from './github-releases.mjs';
import { mainRefGuard, promoteCatalogBatch, publishPluginBatch } from './publish-plugin.mjs';
import { parsePluginTag, verifyPluginTag } from './release-tags.mjs';

const maxBatchSize = 25;

export function parseBatchTags(input) {
  const tags = (input ?? '').split(/\r?\n/).map(tag => tag.trim()).filter(Boolean);
  if (tags.length < 1 || tags.length > maxBatchSize) {
    throw new Error(`batch must contain between 1 and ${maxBatchSize} plugin tags`);
  }
  const keys = new Set();
  for (const tag of tags) {
    const { key } = parsePluginTag(tag);
    if (keys.has(key)) throw new Error(`duplicate plugin release: ${key}`);
    keys.add(key);
  }
  return tags;
}

export async function buildReleaseBatch({ root, out, candidates }) {
  for (const { key, sourceCommit, tag } of candidates) {
    await buildCatalog({ root, out: path.join(out, key), sourceCommit, tag, key });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mainRefGuard();
  const [command, location] = process.argv.slice(2);
  const { PLUGIN_RELEASE_TAGS, GH_TOKEN, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT } = process.env;
  const root = fileURLToPath(new URL('..', import.meta.url));
  const candidates = parseBatchTags(PLUGIN_RELEASE_TAGS).map(tag => ({ tag, ...verifyPluginTag({ root, tag }) }));
  if (command === 'build' && location) {
    await buildReleaseBatch({ root, out: location, candidates });
  } else if (command === 'publish' && location) {
    const api = new GitHubReleases({ token: GH_TOKEN });
    await publishPluginBatch({
      api,
      candidates: candidates.map(candidate => ({ ...candidate, directory: path.join(location, candidate.key) })),
    });
  } else if (command === 'promote' && !location) {
    const api = new GitHubReleases({ token: GH_TOKEN });
    const catalogTag = `catalog-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}`;
    console.log(`Catalog promotion: ${await promoteCatalogBatch({ api, candidates, catalogTag })}`);
  } else {
    throw new Error('expected build <output directory>, publish <output directory>, or promote');
  }
}
