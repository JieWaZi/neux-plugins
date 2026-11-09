import { buildCatalog } from './build-catalog.mjs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const childPath = (directory, relative) => {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\\') || relative.includes(':') || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('unsafe packager artifact path');
  return path.join(directory, relative);
};

async function resolvePackager(explicit, cache) {
  const lock = JSON.parse(await readFile(new URL('./packager.lock.json', import.meta.url), 'utf8'));
  if (lock.schemaVersion !== 1 || !lock.generatorVersion) throw new Error('invalid packager lock');
  if (explicit) {
    if (!path.isAbsolute(explicit)) throw new Error('NEUX_PLUGIN_PACKAGER must be an absolute executable path');
    const binary = await realpath(explicit);
    if (!(await stat(binary)).isFile()) throw new Error('invalid packager executable');
    return { binary, generatorVersion: lock.generatorVersion, binarySHA256: digest(await readFile(binary)), developmentOverride: true };
  }
  const asset = lock.assets[`${process.platform}-${process.arch}`];
  if (!asset) throw new Error('No published packager is pinned for this platform. Build server/cmd/pluginpack and set NEUX_PLUGIN_PACKAGER explicitly for development.');
  const url = new URL(asset.url);
  if (url.protocol !== 'https:' || url.username || url.password || !/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.size) || asset.size <= 0) throw new Error('invalid published packager binding');
  await mkdir(cache, { recursive: true });
  const binary = path.join(cache, `pluginpack-${asset.sha256}${process.platform === 'win32' ? '.exe' : ''}`);
  let bytes = await readFile(binary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!bytes || bytes.length !== asset.size || digest(bytes) !== asset.sha256) {
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
    if (!response.ok || new URL(response.url).protocol !== 'https:') throw new Error('packager download failed');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > asset.size) throw new Error('packager download exceeds pinned size');
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks);
    if (bytes.length !== asset.size || digest(bytes) !== asset.sha256) throw new Error('packager download integrity mismatch');
    await writeFile(binary, bytes, { mode: 0o700 });
  }
  await chmod(binary, 0o700);
  return { binary, generatorVersion: lock.generatorVersion, binarySHA256: asset.sha256, developmentOverride: false };
}

// Portable packages, details and CLI targets all come from the same immutable Git snapshot.
// Target conversion lives exclusively in pluginpack, shared with the host installation path.
export async function buildRelease({ root, out, sourceCommit, tag, packager = process.env.NEUX_PLUGIN_PACKAGER }) {
  const tool = await resolvePackager(packager, path.join(root, '.cache/packager'));
  await mkdir(path.dirname(out), { recursive: true });
  const stage = await mkdtemp(`${out}.release-`), temporary = await mkdtemp(path.join(tmpdir(), 'neux-release-source-'));
  try {
    const catalog = await buildCatalog({ root, out: stage, sourceCommit, tag });
    const packages = [];
    for (const entry of catalog.entries) {
      const extracted = path.join(temporary, entry.key);
      await mkdir(extracted);
      execFileSync('unzip', ['-q', path.join(stage, `${entry.key}.zip`), '-d', extracted], { stdio: 'pipe' });
      const targetOut = path.join(stage, 'targets', entry.key);
      const sourceID = `${sourceCommit}:${entry.packagePath}`;
      execFileSync(tool.binary, ['--source', path.join(extracted, entry.packagePath), '--output', targetOut, '--profile', 'all', '--source-id', sourceID], { stdio: 'pipe', maxBuffer: 16 * 1024 * 1024 });
      const receipt = JSON.parse(await readFile(path.join(targetOut, 'artifacts.json'), 'utf8'));
      if (receipt.schemaVersion !== 1 || receipt.sourceID !== sourceID || receipt.name !== entry.name || receipt.version !== entry.version || !/^[a-f0-9]{64}$/.test(receipt.sourceDigest) || !Array.isArray(receipt.artifacts) || receipt.artifacts.length !== 10) throw new Error(`packager source binding mismatch: ${entry.key}`);
      if (receipt.generatorVersion !== tool.generatorVersion) throw new Error(`packager generatorVersion mismatch: expected ${tool.generatorVersion}, received ${receipt.generatorVersion}`);
      const runtimes = new Set();
      for (const artifact of receipt.artifacts) {
        if (!['codex', 'claude', 'cursor', 'workbuddy', 'qoder', 'kimi', 'gemini', 'grok', 'opencode', 'pi'].includes(artifact.runtime) || runtimes.has(artifact.runtime)) throw new Error('incomplete or duplicate target profiles');
        runtimes.add(artifact.runtime);
        if (digest(await readFile(childPath(targetOut, artifact.archive))) !== artifact.archiveSHA256 || !(await stat(childPath(targetOut, artifact.directory))).isDirectory() || !/^[a-f0-9]{64}$/.test(artifact.contentDigest)) throw new Error(`packager artifact digest mismatch: ${entry.key}/${artifact.runtime}`);
      }
      packages.push({ key: entry.key, sourceID, sourceDigest: receipt.sourceDigest, portableArchive: `${entry.key}.zip`, portableSHA256: entry.archiveSHA256, receipt: `targets/${entry.key}/artifacts.json` });
    }
    const release = { schemaVersion: 1, sourceCommit, tag, packager: { generatorVersion: tool.generatorVersion, binarySHA256: tool.binarySHA256, developmentOverride: tool.developmentOverride }, packages };
    await writeFile(path.join(stage, 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
    try { await cp(path.join(out, 'providers'), path.join(stage, 'providers'), { recursive: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rm(out, { recursive: true, force: true });
    await rename(stage, out);
    return release;
  } finally {
    await rm(temporary, { recursive: true, force: true }); await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const sourceCommit = execFileSync('git', ['-C', root, 'rev-parse', '--verify', `${process.argv[2] || 'HEAD'}^{commit}`], { encoding: 'utf8' }).trim();
  const tag = process.argv[3] || 'v0.1.3-dev';
  const out = process.argv[4] ? path.resolve(process.argv[4]) : path.join(root, 'dist');
  console.log(JSON.stringify(await buildRelease({ root, sourceCommit, tag, out }), null, 2));
}
