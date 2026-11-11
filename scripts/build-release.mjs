import { buildCatalog } from './build-catalog.mjs';
import { digest, verifyTargetReceipt } from './release-artifacts.mjs';
import { commitPattern, sha256Pattern } from './release-tags.mjs';
import { execFileSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

async function buildPinnedPackager(lock, temporary) {
  const { commit, goVersion, receiptIncludesGeneratorVersion } = lock.source;
  if (!commitPattern.test(commit) || !/^\d+\.\d+\.\d+$/.test(goVersion) ||
      typeof receiptIncludesGeneratorVersion !== 'boolean' || lock.repository !== 'https://github.com/JieWaZi/NeuxBot') {
    throw new Error('invalid packager source binding');
  }
  const env = { ...process.env, GOTOOLCHAIN: 'local', GOWORK: 'off', CGO_ENABLED: '0', GOFLAGS: '' };
  const version = execFileSync('go', ['env', 'GOVERSION'], { cwd: temporary, env, encoding: 'utf8' }).trim();
  if (version !== `go${goVersion}`) throw new Error(`packager requires Go ${goVersion}; found ${version}`);
  const checkout = path.join(temporary, 'packager-source');
  const git = args => execFileSync('git', args, { cwd: temporary, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '--quiet', checkout]);
  git(['-C', checkout, 'fetch', '--quiet', '--no-tags', '--depth=1', lock.repository, commit]);
  git(['-C', checkout, 'checkout', '--quiet', '--detach', 'FETCH_HEAD']);
  if (git(['-C', checkout, 'rev-parse', 'HEAD']) !== commit) throw new Error('packager source checkout integrity mismatch');
  const binary = path.join(temporary, process.platform === 'win32' ? 'pluginpack.exe' : 'pluginpack');
  execFileSync('go', ['build', '-mod=readonly', '-trimpath', '-buildvcs=false', '-o', binary, './cmd/pluginpack'], {
    cwd: path.join(checkout, 'server'), env, stdio: 'pipe',
  });
  return {
    binary,
    binarySHA256: digest(await readFile(binary)),
    generatorVersion: lock.generatorVersion,
    developmentOverride: false,
    receiptIncludesGeneratorVersion,
    source: { repository: lock.repository, commit, goVersion },
  };
}

async function resolvePackager(explicit, cache, temporary) {
  const lock = JSON.parse(await readFile(new URL('./packager.lock.json', import.meta.url), 'utf8'));
  if (lock.schemaVersion !== 1 || !lock.generatorVersion) throw new Error('invalid packager lock');
  if (explicit) {
    if (!path.isAbsolute(explicit)) throw new Error('NEUX_PLUGIN_PACKAGER must be an absolute executable path');
    const binary = await realpath(explicit);
    if (!(await stat(binary)).isFile()) throw new Error('invalid packager executable');
    return { binary, generatorVersion: lock.generatorVersion, binarySHA256: digest(await readFile(binary)), developmentOverride: true, receiptIncludesGeneratorVersion: false };
  }
  const asset = lock.assets[`${process.platform}-${process.arch}`];
  if (!asset && lock.source) return buildPinnedPackager(lock, temporary);
  if (!asset) throw new Error('No packager asset or source is pinned for this platform. Set NEUX_PLUGIN_PACKAGER explicitly for development.');
  const url = new URL(asset.url);
  if (url.protocol !== 'https:' || url.username || url.password || !sha256Pattern.test(asset.sha256) || !Number.isSafeInteger(asset.size) || asset.size <= 0) throw new Error('invalid published packager binding');
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
  return { binary, generatorVersion: lock.generatorVersion, binarySHA256: asset.sha256, developmentOverride: false, receiptIncludesGeneratorVersion: true, assetURL: asset.url };
}

// Portable packages, details and CLI targets all come from the same immutable Git snapshot.
// Target conversion lives exclusively in pluginpack, shared with the host installation path.
export async function buildRelease({ root, out, sourceCommit, tag, key, packager = process.env.NEUX_PLUGIN_PACKAGER }) {
  await mkdir(path.dirname(out), { recursive: true });
  const stage = await mkdtemp(`${out}.release-`), temporary = await mkdtemp(path.join(tmpdir(), 'neux-release-source-'));
  try {
    const catalog = await buildCatalog({ root, out: stage, sourceCommit, tag, key });
    const tool = await resolvePackager(packager, path.join(root, '.cache/packager'), temporary);
    const packages = [];
    for (const entry of catalog.entries) {
      const extracted = path.join(temporary, entry.key);
      await mkdir(extracted);
      execFileSync('unzip', ['-q', path.join(stage, `${entry.key}.zip`), '-d', extracted], { stdio: 'pipe' });
      const targetOut = path.join(stage, 'targets', entry.key);
      const sourceID = `${sourceCommit}:${entry.packagePath}`;
      execFileSync(tool.binary, ['--source', path.join(extracted, entry.packagePath), '--output', targetOut, '--profile', 'all', '--source-id', sourceID], { stdio: 'pipe', maxBuffer: 16 * 1024 * 1024 });
      const receipt = JSON.parse(await readFile(path.join(targetOut, 'artifacts.json'), 'utf8'));
      verifyTargetReceipt(receipt, entry);
      if ((tool.receiptIncludesGeneratorVersion || Object.hasOwn(receipt, 'generatorVersion')) && receipt.generatorVersion !== tool.generatorVersion) {
        throw new Error(`packager generatorVersion mismatch: expected ${tool.generatorVersion}, received ${receipt.generatorVersion}`);
      }
      for (const artifact of receipt.artifacts) {
        if (digest(await readFile(path.join(targetOut, artifact.archive))) !== artifact.archiveSHA256 ||
            !(await stat(path.join(targetOut, artifact.directory))).isDirectory()) throw new Error(`packager artifact digest mismatch: ${entry.key}/${artifact.runtime}`);
      }
      packages.push({ key: entry.key, sourceID, sourceDigest: receipt.sourceDigest, portableArchive: `${entry.key}.zip`, portableSHA256: entry.archiveSHA256, receipt: `targets/${entry.key}/artifacts.json` });
    }
    const { generatorVersion, binarySHA256, developmentOverride, source, assetURL } = tool;
    const release = { schemaVersion: 1, sourceCommit, tag, packager: { generatorVersion, binarySHA256, developmentOverride, source, assetURL }, packages };
    await writeFile(path.join(stage, 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
    if (key === undefined && !tag?.includes('@')) {
      try { await cp(path.join(out, 'providers'), path.join(stage, 'providers'), { recursive: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
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
