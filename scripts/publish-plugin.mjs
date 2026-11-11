import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitHubReleases, assetBinding } from './github-releases.mjs';
import { digest, verifyTargetReceipt } from './release-artifacts.mjs';
import { catalogAsset, catalogTagPattern, entryAsset, isCatalogReleaseTag, latestCatalogURL, maxCatalogBytes, mergeCatalog, readCatalog, readEntry } from './release-catalog.mjs';
import { commitPattern, parsePluginTag, repository, sha256Pattern, verifyPluginTag } from './release-tags.mjs';

const makeAsset = (name, bytes) => ({ name, bytes, size: bytes.length, sha256: digest(bytes) });
const sameAsset = (a, b) => a.size === b.size && a.sha256 === b.sha256;

async function checkPackager(packager, receipt) {
  const lock = JSON.parse(await readFile(new URL('./packager.lock.json', import.meta.url), 'utf8'));
  if (packager?.developmentOverride !== false || packager.generatorVersion !== lock.generatorVersion || !sha256Pattern.test(packager.binarySHA256)) {
    throw new Error('release was not built with a pinned packager');
  }
  const binary = !packager.source && Object.values(lock.assets).some(asset => asset.url === packager.assetURL && asset.sha256 === packager.binarySHA256);
  const source = lock.source && !packager.assetURL && packager.source?.repository === lock.repository &&
    packager.source?.commit === lock.source.commit && packager.source?.goVersion === lock.source.goVersion;
  if ((!source && !binary) ||
      ((binary || lock.source?.receiptIncludesGeneratorVersion || Object.hasOwn(receipt, 'generatorVersion')) &&
        receipt.generatorVersion !== lock.generatorVersion)) {
    throw new Error('release packager provenance or generator version mismatch');
  }
}

async function builtAssets({ directory, tag, sourceCommit }) {
  const { key } = parsePluginTag(tag);
  const read = file => readFile(path.join(directory, file));
  const [entryBytes, releaseBytes] = await Promise.all([read(catalogAsset), read('release.json')]);
  const entry = readEntry(entryBytes, { tag, sourceCommit });
  const release = JSON.parse(releaseBytes);
  const portable = `${key}.zip`;
  const details = `${key}.details.json`;
  const targetDir = `targets/${key}`;
  const receiptPath = `${targetDir}/artifacts.json`;
  const receiptBytes = await read(receiptPath);
  const receipt = JSON.parse(receiptBytes);
  verifyTargetReceipt(receipt, entry);
  await checkPackager(release.packager, receipt);
  const [pkg] = release.packages ?? [];
  if (release.schemaVersion !== 1 || release.sourceCommit !== sourceCommit || release.tag !== tag || release.packages?.length !== 1 ||
      pkg?.key !== key || pkg.sourceID !== receipt.sourceID || pkg.sourceDigest !== receipt.sourceDigest ||
      pkg.portableArchive !== portable || pkg.portableSHA256 !== entry.archiveSHA256 || pkg.receipt !== receiptPath) {
    throw new Error(`release receipt does not match the tagged plugin: ${tag}`);
  }
  async function verifiedAsset(name, file, sha256, size) {
    const asset = makeAsset(name, await read(file));
    if (asset.size === 0 || asset.sha256 !== sha256 || (size !== undefined && asset.size !== size)) {
      throw new Error(`built asset digest or size mismatch: ${file}`);
    }
    return asset;
  }
  const assets = [
    makeAsset(entryAsset, entryBytes),
    makeAsset('release.json', releaseBytes),
    makeAsset('artifacts.json', receiptBytes),
    await verifiedAsset(portable, portable, entry.archiveSHA256),
    await verifiedAsset(details, details, entry.detailsSHA256, entry.detailsSize),
    ...await Promise.all(receipt.artifacts.map(artifact =>
      verifiedAsset(artifact.archive, `${targetDir}/${artifact.archive}`, artifact.archiveSHA256))),
  ];
  return { entry, assets };
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
  const body = `Source commit: ${sourceCommit}\n\n${assets[0].name} SHA-256: ${assets[0].sha256}`;
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
  await api.retryRead(() => Promise.all(assets.map(asset => api.downloadAsset(release, asset))));
  return release;
}

export async function publishPlugin({ api, directory, tag, sourceCommit }) {
  const { entry, assets } = await builtAssets({ directory, tag, sourceCommit });
  await api.verifyTag(tag, sourceCommit);
  // Catch legacy same-version conflicts before creating the new fixed release.
  const base = await readLatest(api);
  const { status } = mergeCatalog(base.catalog, entry);
  await publishRelease({
    api, tag, sourceCommit, assets, latest: false, allowNew: status !== 'superseded',
    beforePublish: () => api.verifyTag(tag, sourceCommit),
  });
}

async function candidateFromRelease(api, tag, sourceCommit) {
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
    return entry;
  });
}

async function verifyLatest(api, release, asset) {
  await api.retryRead(async () => {
    const current = checkRelease(await api.latestRelease(), release.tag_name, false);
    if (current.id !== release.id || !sameAsset(assetBinding(current, catalogAsset), asset)) {
      throw new Error(`latest catalog release binding changed: ${release.tag_name}`);
    }
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

export async function promoteCatalog({ api, tag, sourceCommit, catalogTag }) {
  if (!catalogTagPattern.test(catalogTag)) throw new Error('invalid catalog promotion tag');
  parsePluginTag(tag);
  const candidate = await candidateFromRelease(api, tag, sourceCommit);
  const base = await readLatest(api);
  const { status, catalog } = mergeCatalog(base.catalog, candidate);
  if (status !== 'changed') {
    await verifyLatest(api, base.release, base.asset);
    return status;
  }
  const content = Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`);
  if (content.length > maxCatalogBytes) throw new Error('merged catalog exceeds the client size limit');
  const asset = makeAsset(catalogAsset, content);
  const release = await publishRelease({
    api, tag: catalogTag, sourceCommit, assets: [asset], latest: true,
    beforePublish: async () => {
      const current = checkRelease(await api.latestRelease(), base.release.tag_name, false);
      if (current.id !== base.release.id || !sameAsset(assetBinding(current, catalogAsset), base.asset)) {
        throw new Error('latest catalog changed while preparing the draft');
      }
    },
  });
  await verifyLatest(api, release, asset);
  return status;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, tag, sourceCommit, directory] = process.argv.slice(2);
  if (!commitPattern.test(sourceCommit)) throw new Error('sourceCommit must be a full Git commit');
  if (command === 'check-tag') {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const { key } = verifyPluginTag({ root, tag, sourceCommit });
    console.log(`key=${key}\nsource_commit=${sourceCommit}`);
  } else {
    const { GITHUB_ACTIONS, GITHUB_EVENT_NAME, GITHUB_REF_TYPE, GITHUB_REF_NAME, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GH_TOKEN } = process.env;
    if (GITHUB_ACTIONS !== 'true' || GITHUB_EVENT_NAME !== 'push' || GITHUB_REF_TYPE !== 'tag' ||
        tag !== GITHUB_REF_NAME || GITHUB_REPOSITORY !== repository) {
      throw new Error('publishing requires a tag push workflow in the maintained plugin repository');
    }
    const api = new GitHubReleases({ token: GH_TOKEN });
    if (command === 'publish' && directory) await publishPlugin({ api, directory, tag, sourceCommit });
    else if (command === 'promote') {
      const catalogTag = `catalog-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}`;
      console.log(`Catalog promotion: ${await promoteCatalog({ api, tag, sourceCommit, catalogTag })}`);
    } else throw new Error('expected publish <tag> <sourceCommit> <directory> or promote <tag> <sourceCommit>');
  }
}
