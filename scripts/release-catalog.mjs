import { isStableVersion, parsePluginTag, pluginKeyPattern, releaseURL, repository } from './release-tags.mjs';
import { validateSchema } from './schema.mjs';

export const catalogAsset = 'catalog.json';
export const entryAsset = 'entry.json';
export const maxCatalogBytes = 4 * 1024 * 1024;
export const latestCatalogURL = `https://github.com/${repository}/releases/latest/download/${catalogAsset}`;
export const catalogTagPattern = /^catalog-[1-9][0-9]*-[1-9][0-9]*$/;
const legacyTagPattern = /^v[0-9]+\.[0-9]+\.[0-9]+$/;
const archiveURLPrefix = `https://github.com/${repository}/releases/download/`;
const bindingFields = ['sourceCommit', 'archiveURL', 'archiveSHA256', 'packagePath', 'detailsURL', 'detailsSHA256', 'detailsSize'];

export function isCatalogReleaseTag(tag) {
  return legacyTagPattern.test(tag) || catalogTagPattern.test(tag);
}

export function validateCatalog(catalog) {
  validateSchema('catalog.schema.json', catalog);
  if (catalog.entries.length === 0) throw new Error('release catalog is empty');
  const keys = new Set();
  for (const entry of catalog.entries) {
    const { key, name, version, packagePath, archiveURL, detailsURL } = entry;
    if (!pluginKeyPattern.test(key) || name !== key || packagePath !== `plugins/${key}` || !isStableVersion(version)) {
      throw new Error(`invalid catalog plugin identity: ${key}`);
    }
    if (keys.has(key)) throw new Error(`duplicate catalog key: ${key}`);
    keys.add(key);
    const tag = archiveURL.startsWith(archiveURLPrefix) ? archiveURL.slice(archiveURLPrefix.length).split('/')[0] : '';
    if ((!legacyTagPattern.test(tag) && tag !== `${key}@${version}`) ||
        archiveURL !== releaseURL(tag, `${key}.zip`) ||
        detailsURL !== releaseURL(tag, `${key}.details.json`)) {
      throw new Error(`catalog entry must use fixed archive and details bindings: ${key}`);
    }
  }
  return catalog;
}

export function readCatalog(bytes) {
  if (bytes.length > maxCatalogBytes) throw new Error('release catalog exceeds the client size limit');
  return validateCatalog(JSON.parse(bytes));
}

export function readEntry(bytes, { tag, sourceCommit }) {
  const catalog = readCatalog(bytes);
  const { key, version } = parsePluginTag(tag);
  const [entry] = catalog.entries;
  if (catalog.entries.length !== 1 || entry.key !== key || entry.version !== version || entry.sourceCommit !== sourceCommit ||
      entry.archiveURL !== releaseURL(tag, `${key}.zip`)) {
    throw new Error(`catalog entry does not match the tagged release: ${tag}`);
  }
  return entry;
}

function compareVersions(a, b) {
  const current = a.split('.').map(BigInt);
  const candidate = b.split('.').map(BigInt);
  for (let part = 0; part < current.length; part++) {
    if (current[part] > candidate[part]) return 1;
    if (current[part] < candidate[part]) return -1;
  }
  return 0;
}

export function mergeCatalog(catalog, candidate) {
  validateCatalog(catalog);
  validateCatalog({ schemaVersion: 1, entries: [candidate] });
  const index = catalog.entries.findIndex(entry => entry.key === candidate.key);
  if (index === -1) return { status: 'changed', catalog: { ...catalog, entries: [...catalog.entries, candidate] } };
  const current = catalog.entries[index];
  const comparison = compareVersions(current.version, candidate.version);
  if (comparison > 0) return { status: 'superseded', catalog };
  if (comparison === 0) {
    if (bindingFields.some(field => current[field] !== candidate[field])) throw new Error(`immutable binding conflict: ${candidate.key}@${candidate.version}`);
    return { status: 'current', catalog };
  }
  return { status: 'changed', catalog: { ...catalog, entries: catalog.entries.map((entry, i) => i === index ? candidate : entry) } };
}
