import { readFile } from 'node:fs/promises';
import { openAsBlob } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { maxDetailsBytes } from './details.mjs';
import { validateSchema } from './schema.mjs';
import { GitHubReleases, assetBinding } from './github-releases.mjs';
import { catalogAsset, catalogTagPattern, encodeCatalog, entryAsset, isCatalogReleaseTag, latestCatalogURL, maxCatalogBytes, mergeCatalog, readCatalog, readEntry } from './release-catalog.mjs';
import { commitPattern, parsePluginTag, repository, verifyPluginTag } from './release-tags.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const makeAsset = (name, bytes) => ({ name, body: bytes, size: bytes.length, sha256: digest(bytes) });
const sameAsset = (a, b) => a.size === b.size && a.sha256 === b.sha256;

async function builtAssets({ directory, tag, sourceCommit }) {
  const { key } = parsePluginTag(tag);
  const read = file => readFile(path.join(directory, file));
  const entryBytes = await read(catalogAsset);
  const entry = readEntry(entryBytes, { tag, sourceCommit });
  const portable = `${key}.zip`;
  const details = `${key}.details.json`;
  async function verifiedAsset(name, file, sha256, size) {
    const body = await openAsBlob(path.join(directory, file));
    const hash = createHash('sha256');
    for await (const chunk of body.stream()) hash.update(chunk);
    if (body.size === 0 || hash.digest('hex') !== sha256 || (size !== undefined && body.size !== size)) {
      throw new Error(`built asset digest or size mismatch: ${file}`);
    }
    return { name, body, size: body.size, sha256 };
  }
  if (entry.detailsSize > maxDetailsBytes) throw new Error('built plugin details exceed the client size limit');
  const detailAsset = await verifiedAsset(details, details, entry.detailsSHA256, entry.detailsSize);
  validateEntryDetails(Buffer.from(await detailAsset.body.arrayBuffer()), entry);
  const assets = [
    makeAsset(entryAsset, entryBytes),
    await verifiedAsset(portable, portable, entry.archiveSHA256),
    detailAsset,
  ];
  return { entry, assets };
}

function validateEntryDetails(content, entry) {
  const details = validateSchema('details.schema.json', JSON.parse(content));
  if (details.sourceCommit !== entry.sourceCommit || details.archiveSHA256 !== entry.archiveSHA256 ||
      details.packagePath !== entry.packagePath || details.package.manifest.name !== entry.name ||
      details.package.manifest.version !== entry.version) {
    throw new Error(`plugin details do not match the catalog entry: ${entry.key}`);
  }
  const hostedOAuth = details.package.integration?.authentication?.strategy === 'mcp-oauth';
  if (hostedOAuth !== details.package.servers.some(server => server.authentication?.type === 'oauth')) {
    throw new Error(`inconsistent hosted OAuth declaration in plugin details: ${entry.key}`);
  }
}

function checkRelease(release, tag, draft) {
  if (release?.tag_name !== tag || !Number.isSafeInteger(release.id) || release.id <= 0 || typeof release.draft !== 'boolean' || release.draft !== draft ||
      release.prerelease !== false || !Array.isArray(release.assets)) {
    throw new Error(`invalid release state: ${tag}`);
  }
  return release;
}

function checkAssetInventory(release, expected, allowMissing) {
  const existing = new Map();
  for (const asset of release.assets) {
    const wanted = expected.get(asset.name);
    if (!wanted || existing.has(asset.name) || !Number.isSafeInteger(asset.id) || asset.id <= 0) {
      throw new Error(`unexpected or duplicate release asset: ${release.tag_name}/${asset.name}`);
    }
    const starter = allowMissing && asset.state === 'starter' && asset.size === 0 && !asset.digest;
    if (!starter && (asset.state !== 'uploaded' || asset.size !== wanted.size || asset.digest !== `sha256:${wanted.sha256}`)) {
      throw new Error(`immutable release asset conflict: ${release.tag_name}/${asset.name}`);
    }
    existing.set(asset.name, asset);
  }
  if (!allowMissing && existing.size !== expected.size) throw new Error(`missing published assets: ${release.tag_name}`);
  return existing;
}

async function publishRelease({ api, tag, sourceCommit, assets, latest, beforePublish, allowNew = true }) {
  const expected = new Map(assets.map(asset => [asset.name, asset]));
  const source = latest ? 'Catalog entries bind their own source commits.' : `Source commit: ${sourceCommit}`;
  const [index] = assets;
  const body = `${source}\n\n${index.name} SHA-256: ${index.sha256}`;
  // The catalog has per-entry source commits. Its own tag points at main when GitHub publishes the draft.
  const targetCommitish = latest ? 'main' : sourceCommit;
  let release = await api.findRelease(tag);
  if (!release && !allowNew) throw new Error(`plugin release is superseded by the current catalog: ${tag}`);
  if (!release) release = await api.createDraft({ tag, targetCommitish, body });
  checkRelease(release, tag, release.draft);
  if (release.draft) {
    if (release.name !== tag || release.body !== body || (latest && release.target_commitish !== targetCommitish)) {
      throw new Error(`draft release binding conflict: ${tag}`);
    }
    const existing = checkAssetInventory(release, expected, true);
    for (const asset of assets) {
      const prior = existing.get(asset.name);
      if (prior?.state === 'uploaded') continue;
      if (prior) await api.discardStarter(prior);
      await api.upload(release, asset);
    }
    const complete = checkRelease(await api.releaseByID(release.id), tag, true);
    checkAssetInventory(complete, expected, false);
    await beforePublish();
    try {
      release = checkRelease(await api.publish(complete, latest), tag, false);
    } catch (publishError) {
      // GitHub may commit the update before the HTTP response reaches the runner.
      release = await api.retryRead(async () => checkRelease(await api.releaseByID(complete.id), tag, false))
        .catch(() => { throw publishError; });
    }
  }
  checkRelease(release, tag, false);
  checkAssetInventory(release, expected, false);
  for (const asset of assets) {
    await api.retryRead(() => api.verifyAsset(release, asset));
  }
  return release;
}

export async function publishPlugin({ api, directory, tag, sourceCommit }) {
  return publishPluginBatch({ api, candidates: [{ directory, tag, sourceCommit }] });
}

export async function publishPluginBatch({ api, candidates }) {
  validateCandidates(candidates);
  const built = [];
  for (const candidate of candidates) {
    const { entry, assets } = await builtAssets(candidate);
    await api.verifyTag(candidate.tag, candidate.sourceCommit);
    built.push({ ...candidate, entry, assets });
  }
  // Verify all bindings and the final catalog size before creating any fixed release.
  const base = await readLatest(api);
  const { status, statuses, catalog } = mergeReleaseEntries(base.catalog, built.map(({ entry }) => entry));
  if (status === 'changed') encodeCatalog(catalog);
  for (const [i, { tag, sourceCommit, assets }] of built.entries()) {
    await publishRelease({
      api, tag, sourceCommit, assets, latest: false, allowNew: statuses[i] !== 'superseded',
      beforePublish: () => api.verifyTag(tag, sourceCommit),
    });
  }
}

async function candidateFromRelease(api, { tag, sourceCommit }) {
  await api.verifyTag(tag, sourceCommit);
  return api.retryRead(async () => {
    const release = checkRelease(await api.releaseByTag(tag), tag, false);
    const single = assetBinding(release, entryAsset);
    if (single.size > maxCatalogBytes) throw new Error('published plugin entry exceeds the client catalog size limit');
    const entry = readEntry(await api.downloadAsset(release, single), { tag, sourceCommit });
    const portable = assetBinding(release, `${entry.key}.zip`);
    const details = assetBinding(release, `${entry.key}.details.json`);
    if (portable.sha256 !== entry.archiveSHA256 || details.sha256 !== entry.detailsSHA256 || details.size !== entry.detailsSize) {
      throw new Error(`published package assets do not match the catalog entry: ${tag}`);
    }
    if (details.size > maxDetailsBytes) throw new Error('published plugin details exceed the client size limit');
    validateEntryDetails(await api.downloadAsset(release, details), entry);
    return entry;
  });
}

async function checkLatest(api, release, asset) {
  const current = checkRelease(await api.latestRelease(), release.tag_name, false);
  if (current.id !== release.id || !sameAsset(assetBinding(current, catalogAsset), asset)) {
    throw new Error(`latest catalog release binding changed: ${release.tag_name}`);
  }
}

async function verifyLatest(api, release, asset) {
  await api.retryRead(async () => {
    await checkLatest(api, release, asset);
    await api.download(latestCatalogURL, asset);
  });
}

function readLatest(api) {
  return api.retryRead(async () => {
    const release = await api.latestRelease();
    if (!isCatalogReleaseTag(release.tag_name)) throw new Error(`latest Release is not a catalog release: ${release.tag_name}`);
    checkRelease(release, release.tag_name, false);
    const asset = assetBinding(release, catalogAsset);
    if (asset.size > maxCatalogBytes) throw new Error('published catalog exceeds the client size limit');
    const catalog = readCatalog(await api.downloadAsset(release, asset));
    return { release, asset, catalog };
  });
}

function mergeReleaseEntries(catalog, entries) {
  const statuses = [];
  for (const entry of entries) {
    const merged = mergeCatalog(catalog, entry);
    catalog = merged.catalog;
    statuses.push(merged.status);
  }
  const status = statuses.includes('changed') ? 'changed' : statuses.includes('current') ? 'current' : 'superseded';
  return { status, statuses, catalog };
}

export async function promoteCatalog({ api, tag, sourceCommit, catalogTag }) {
  return promoteCatalogBatch({ api, candidates: [{ tag, sourceCommit }], catalogTag });
}

function validateCandidates(candidates) {
  if (candidates.length === 0) throw new Error('at least one plugin release is required');
  const keys = new Set();
  for (const { tag, sourceCommit } of candidates) {
    const { key } = parsePluginTag(tag);
    if (keys.has(key)) throw new Error(`duplicate plugin release: ${key}`);
    if (!commitPattern.test(sourceCommit)) throw new Error('sourceCommit must be a full Git commit');
    keys.add(key);
  }
}

export async function promoteCatalogBatch({ api, candidates, catalogTag }) {
  if (!catalogTagPattern.test(catalogTag)) throw new Error('invalid catalog promotion tag');
  validateCandidates(candidates);
  const entries = [];
  for (const candidate of candidates) entries.push(await candidateFromRelease(api, candidate));
  const base = await readLatest(api);
  const { status, catalog } = mergeReleaseEntries(base.catalog, entries);
  if (status !== 'changed') {
    await verifyLatest(api, base.release, base.asset);
    return status;
  }
  const asset = makeAsset(catalogAsset, encodeCatalog(catalog));
  const release = await publishRelease({
    api, tag: catalogTag, assets: [asset], latest: true,
    beforePublish: () => checkLatest(api, base.release, base.asset),
  });
  await verifyLatest(api, release, asset);
  return 'changed';
}

export function mainRefGuard(env = process.env) {
  const { GITHUB_ACTIONS, GITHUB_EVENT_NAME, GITHUB_REF, GITHUB_REF_PROTECTED, GITHUB_REPOSITORY } = env;
  if (GITHUB_ACTIONS !== 'true' || GITHUB_EVENT_NAME !== 'workflow_dispatch' || GITHUB_REF !== 'refs/heads/main' ||
      GITHUB_REF_PROTECTED !== 'true' || GITHUB_REPOSITORY !== repository) {
    throw new Error('publishing requires a dispatch from main with branch protection in the maintained plugin repository');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const [command, tag, sourceCommit, directory] = process.argv.slice(2);
  if (command === 'check-tag') {
    const verified = verifyPluginTag({ root, tag, sourceCommit });
    console.log(`key=${verified.key}\nsource_commit=${verified.sourceCommit}`);
  } else {
    mainRefGuard();
    const { GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GH_TOKEN } = process.env;
    if (!commitPattern.test(sourceCommit)) throw new Error('sourceCommit must be a full Git commit');
    verifyPluginTag({ root, tag, sourceCommit });
    const api = new GitHubReleases({ token: GH_TOKEN });
    if (command === 'publish' && directory) await publishPlugin({ api, directory, tag, sourceCommit });
    else if (command === 'promote') {
      const catalogTag = `catalog-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}`;
      console.log(`Catalog promotion: ${await promoteCatalog({ api, tag, sourceCommit, catalogTag })}`);
    } else throw new Error('expected publish <tag> <sourceCommit> <directory> or promote <tag> <sourceCommit>');
  }
}
