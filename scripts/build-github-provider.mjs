import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const commit = 'fc4b137cdef0a6bd28fd461b7cf9c84a5812a8cd';
const sourceSHA256 = '78542f85b4c271bc641eba52c14257c9f388d793a114ce97d0fac2bd19035773';
const sourceURL = `https://github.com/cli/cli/archive/${commit}.tar.gz`;
const version = '2.102.0-neuxally.2';
const toolchain = 'go1.27.1';
const releaseURL = 'https://github.com/JieWaZi/neux-plugins/releases/download/v0.1.0';
const noticesName = `gh-${version}-NOTICES.txt`;
const hash = value => createHash('sha256').update(value).digest('hex');
export const targets = Object.freeze(['darwin-arm64', 'darwin-amd64', 'linux-arm64', 'linux-amd64', 'windows-arm64', 'windows-amd64']);

export function assetFilename(target) {
  if (!targets.includes(target)) throw new Error(`unsupported build target: ${target}`);
  return `gh-${version}-${target}${target.startsWith('windows-') ? '.exe' : ''}`;
}

// 资产锁只能从完整六平台产物和实际补丁字节生成，不能由手写摘要补齐。
export async function buildAssetLock({ root, output, notices }) {
  const assets = {};
  for (const target of targets) {
    const filename = assetFilename(target), bytes = await readFile(path.join(output, filename));
    if (!bytes.length) throw new Error(`empty build artifact: ${target}`);
    const [platform, architecture] = target.split('-');
    assets[`${platform === 'windows' ? 'win32' : platform}-${architecture === 'amd64' ? 'x64' : architecture}`] = { url: `${releaseURL}/${filename}`, sha256: hash(bytes), size: bytes.length };
  }
  return {
    schemaVersion: 1, version,
    notices: { url: `${releaseURL}/${noticesName}`, sha256: hash(notices) },
    source: {
      repository: 'https://github.com/cli/cli', commit, archiveURL: sourceURL, archiveSHA256: sourceSHA256,
      toolchain, patchSHA256: hash(await readFile(path.join(root, 'patches/github-keyring-isolation.patch'))),
      verificationSHA256: hash(await readFile(path.join(root, 'patches/github-keyring-isolation_test.go'))),
    }, assets,
  };
}

async function writeAtomic(filename, bytes) {
  await mkdir(path.dirname(filename), { recursive: true });
  const directory = await mkdtemp(path.join(path.dirname(filename), '.gh-write-'));
  try { const temporary = path.join(directory, 'content'); await writeFile(temporary, bytes); await rename(temporary, filename); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

// 源码压缩包也固定完整摘要；缓存损坏时重取，不把网络错误写成有效缓存。
async function loadSource(root, sourceArchive, fetcher) {
  if (sourceArchive) {
    const bytes = await readFile(sourceArchive);
    if (hash(bytes) !== sourceSHA256) throw new Error('source digest mismatch');
    return bytes;
  }
  const cache = path.join(root, '.cache/providers', `github-cli-${commit}.tar.gz`);
  try { const bytes = await readFile(cache); if (hash(bytes) === sourceSHA256) return bytes; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const response = await fetcher(sourceURL, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`source download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (hash(bytes) !== sourceSHA256) throw new Error('source digest mismatch');
  await writeAtomic(cache, bytes);
  return bytes;
}

async function dependencyNotices(source, environment) {
  const modules = new Map();
  // 六平台逐个取真实构建依赖图，不能假设架构没有额外模块。
  for (const target of targets) {
    const [GOOS, GOARCH] = target.split('-');
    const list = execFileSync('go', ['list', '-mod=readonly', '-deps', '-f', '{{if .Module}}{{.Module.Path}}@{{.Module.Version}}|{{.Module.Dir}}{{end}}', './cmd/gh'], { cwd: source, env: { ...environment, GOOS, GOARCH }, encoding: 'utf8', maxBuffer: 16 << 20 });
    for (const line of list.split('\n').filter(Boolean)) { const [name, directory] = line.split('|'); modules.set(name, directory); }
  }
  const goRoot = execFileSync('go', ['env', 'GOROOT'], { env: environment, encoding: 'utf8' }).trim();
  const sections = [
    `GitHub CLI 隔离构建与依赖许可\n固定源码 cli/cli@${commit}，构建 ${version}；以下从六平台真实 Go 依赖图收集模块原始 LICENSE、COPYING、NOTICE，保留作者与版权，不补造声明。`,
    `Go runtime (${toolchain})\n${await readFile(path.join(goRoot, 'LICENSE'), 'utf8')}`,
  ];
  for (const [name, directory] of [...modules].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    const licenses = [];
    async function collect(relative = '') {
      for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
        const filename = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory() && !entry.name.startsWith('.')) await collect(filename);
        else if (entry.isFile() && /^(licen[cs]e|copying|notice)([.-].*)?$/i.test(entry.name)) licenses.push(filename);
      }
    }
    await collect();
    if (!licenses.length) {
      const readme = (await readdir(directory)).find(filename => /^readme(?:\.md|\.txt)?$/i.test(filename));
      if (!readme || !/licen[cs]e|copyright/i.test(await readFile(path.join(directory, readme), 'utf8'))) throw new Error(`missing dependency license evidence: ${name}`);
      sections.push(`${name}: 模块没有独立 LICENSE；以下保留 README 的原始许可与作者证据。`); licenses.push(readme);
    }
    for (const filename of licenses.sort()) sections.push(`${name} / ${filename}\n${await readFile(path.join(directory, filename), 'utf8')}`);
  }
  return `${sections.join('\n\n----------------------------------------\n\n').trimEnd()}\n`;
}

export async function buildGitHubProvider({ root = repositoryRoot, sourceArchive, fetcher = fetch } = {}) {
  const work = await mkdtemp(path.join(tmpdir(), 'neuxbot-gh-build-'));
  const environment = { ...process.env, GOTOOLCHAIN: toolchain, GOWORK: 'off', CGO_ENABLED: '0', GOFLAGS: '', GOAMD64: 'v1', GOARM64: 'v8.0', GOEXPERIMENT: '', GOOS: process.platform === 'win32' ? 'windows' : process.platform, GOARCH: process.arch === 'x64' ? 'amd64' : process.arch };
  try {
    const archive = path.join(work, 'source.tar.gz'); await writeFile(archive, await loadSource(root, sourceArchive, fetcher));
    const source = path.join(work, 'source'), output = path.join(work, 'providers'); await mkdir(source); await mkdir(output);
    execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', source]);
    const patch = path.join(root, 'patches/github-keyring-isolation.patch');
    execFileSync('git', ['apply', '--unidiff-zero', '--check', patch], { cwd: source });
    execFileSync('git', ['apply', '--unidiff-zero', patch], { cwd: source });
    await copyFile(path.join(root, 'patches/github-keyring-isolation_test.go'), path.join(source, 'internal/config/neuxally_isolation_test.go'));
    console.log('Verifying private keyring Set/Get/Delete, profile isolation, login/logout and migration');
    execFileSync('go', ['test', '-mod=readonly', './internal/config', '-run', '^TestNeuxAlly', '-count=1'], { cwd: source, env: environment, stdio: 'inherit' });
    console.log('Collecting original dependency licenses from six target graphs');
    const notices = await dependencyNotices(source, environment);
    await writeFile(path.join(output, noticesName), notices);
    for (const target of targets) {
      const [GOOS, GOARCH] = target.split('-'), binary = path.join(output, assetFilename(target));
      execFileSync('go', ['build', '-mod=readonly', '-trimpath', '-buildvcs=false', '-ldflags', `-s -w -X github.com/cli/cli/v2/internal/build.Version=${version} -X github.com/cli/cli/v2/internal/build.Date=2026-10-19`, '-o', binary, './cmd/gh'], { cwd: source, env: { ...environment, GOOS, GOARCH }, stdio: 'inherit' });
      await chmod(binary, 0o755);
      console.log(`Built ${target}: ${hash(await readFile(binary))}`);
    }
    const lock = await buildAssetLock({ root, output, notices });
    // 构建和校验全部成功后才发布生成锁；失败不会留下指向半套资产的锁。
    const destination = path.join(root, 'dist/providers'); await mkdir(destination, { recursive: true });
    for (const filename of [...targets.map(assetFilename), noticesName]) await rename(path.join(output, filename), path.join(destination, filename));
    const auth = path.join(root, 'plugins/github/.neuxally/auth');
    await writeAtomic(path.join(auth, 'THIRD_PARTY_NOTICES.cli.txt'), notices);
    await writeAtomic(path.join(auth, 'assets.lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
    return lock;
  } finally { await rm(work, { recursive: true, force: true }); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--source-archive')) throw new Error('usage: node scripts/build-github-provider.mjs [--source-archive <verified-local-archive>]');
  await buildGitHubProvider({ sourceArchive: args[1] });
}
