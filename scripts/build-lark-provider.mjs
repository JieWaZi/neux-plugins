import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const commit = 'ac81f5056ab88f37d581d25916f3dab85abfca76';
const sourceSHA256 = 'c8247b1364b6d56b068709c3ce29aa191fdbfff1ccc11ccc143a34d5df1f4936';
const version = '1.0.98-neuxbot.1';
const hash = value => createHash('sha256').update(value).digest('hex');
const targets = process.argv.slice(2);
const selected = targets.length ? targets : ['darwin-arm64', 'darwin-amd64', 'linux-amd64', 'linux-arm64', 'windows-amd64', 'windows-arm64'];
const work = await mkdtemp(path.join(tmpdir(), 'neuxbot-lark-build-'));
const output = path.join(root, 'dist/providers'); await mkdir(output, { recursive: true });
const env = { ...process.env, GOTOOLCHAIN: 'go1.25.8', CGO_ENABLED: '0', GOFLAGS: '', GOAMD64: 'v1', GOARM64: 'v8.0', GOEXPERIMENT: '' };
try {
  const sourceURL = `https://codeload.github.com/larksuite/cli/tar.gz/${commit}`;
  const response = await fetch(sourceURL); if (!response.ok) throw new Error('source download failed');
  const archive = Buffer.from(await response.arrayBuffer()); if (hash(archive) !== sourceSHA256) throw new Error('source digest mismatch');
  const archivePath = path.join(work, 'source.tar.gz'); await writeFile(archivePath, archive);
  const source = path.join(work, 'source'); await mkdir(source);
  execFileSync('tar', ['-xzf', archivePath, '--strip-components=1', '-C', source]);
  execFileSync('git', ['apply', '--unidiff-zero', path.join(root, 'patches/lark-keychain-isolation.patch')], { cwd: source });
  await copyFile(path.join(root, 'patches/lark-keychain-isolation_test.go'), path.join(source, 'internal/keychain/neuxally_isolation_test.go'));
  await copyFile(path.join(root, 'patches/lark-storage-isolation_darwin_test.go'), path.join(source, 'internal/keychain/neuxbot_storage_darwin_test.go'));
  execFileSync('go', ['test', './internal/keychain', '-run', 'TestNeuxAllyPrivate(Service|Storage)', '-count=1'], { cwd: source, env, stdio: 'inherit' });
  // 从六平台真实依赖图收集原文许可；原始程序资产旁和插件快照内均交付声明。
  const modules = new Map();
  for (const platform of ['darwin', 'linux', 'windows']) {
    const list = execFileSync('go', ['list', '-deps', '-f', '{{if .Module}}{{.Module.Path}}@{{.Module.Version}}|{{.Module.Dir}}{{end}}', '.'], { cwd: source, env: { ...env, GOOS: platform, GOARCH: 'arm64' }, encoding: 'utf8' });
    for (const line of list.split('\n').filter(Boolean)) { const [name, directory] = line.split('|'); modules.set(name, directory); }
  }
  const goRoot = execFileSync('go', ['env', 'GOROOT'], { env, encoding: 'utf8' }).trim();
  const notices = ['Lark CLI 隔离构建与依赖许可\n以下内容从固定源码和三个操作系统的真实 Go 依赖图收集，包含模块内可得的原始 LICENSE、COPYING、NOTICE；不同架构共用模块版本。\n', `Go runtime (go1.25.8)\n${await readFile(path.join(goRoot, 'LICENSE'), 'utf8')}`];
  for (const [name, directory] of [...modules].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    const licenses = [];
    async function collect(relative = '') {
      for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
        const filename = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory() && !entry.name.startsWith('.')) await collect(filename);
        else if (entry.isFile() && /^(license|copying|notice)([.-].*)?$/i.test(entry.name)) licenses.push(filename);
      }
    }
    await collect();
    if (!licenses.length) {
      const readme = (await readdir(directory)).find(filename => /^readme(?:\.md|\.txt)?$/i.test(filename));
      if (!readme || !/licen[cs]e|copyright/i.test(await readFile(path.join(directory, readme), 'utf8'))) throw new Error(`missing dependency license evidence: ${name}`);
      notices.push(`${name}: 模块没有独立 LICENSE；以下保留 README 的原始许可与作者证据，不补造版权文本。`); licenses.push(readme);
    }
    for (const filename of licenses.sort()) notices.push(`${name} / ${filename}\n${await readFile(path.join(directory, filename), 'utf8')}`);
  }
  const noticesText = `${notices.join('\n\n----------------------------------------\n\n').trimEnd()}\n`;
  const noticesName = `lark-cli-${version}-NOTICES.txt`;
  await writeFile(path.join(output, noticesName), noticesText);
  await writeFile(path.join(root, 'plugins/feishu-office/.neuxally/auth/THIRD_PARTY_NOTICES.cli.txt'), noticesText);
  const assets = {};
  for (const target of selected) {
    if (!/^(darwin|linux|windows)-(amd64|arm64)$/.test(target)) throw new Error(`unsupported build target: ${target}`);
    const [platform, architecture] = target.split('-');
    const name = `lark-cli-${version}-${target}${platform === 'windows' ? '.exe' : ''}`;
    const binary = path.join(output, name);
    execFileSync('go', ['build', '-trimpath', '-buildvcs=false', '-ldflags', `-s -w -X github.com/larksuite/cli/internal/build.Version=${version} -X github.com/larksuite/cli/internal/build.Date=2026-10-19`, '-o', binary, '.'], { cwd: source, env: { ...env, GOOS: platform, GOARCH: architecture }, stdio: 'inherit' });
    await chmod(binary, 0o755); const bytes = await readFile(binary);
    assets[`${platform === 'windows' ? 'win32' : platform}-${architecture === 'amd64' ? 'x64' : architecture}`] = { url: `https://github.com/JieWaZi/neux-plugins/releases/download/v0.1.0/${name}`, sha256: hash(bytes), size: bytes.length };
    console.log(`Built ${target}: ${hash(bytes)}`);
  }
  const lock = { schemaVersion: 1, version, notices: { url: `https://github.com/JieWaZi/neux-plugins/releases/download/v0.1.0/${noticesName}`, sha256: hash(noticesText) }, source: { repository: 'https://github.com/larksuite/cli', commit, archiveURL: sourceURL, archiveSHA256: sourceSHA256, toolchain: 'go1.25.8', patchSHA256: hash(await readFile(path.join(root, 'patches/lark-keychain-isolation.patch'))), verificationSHA256: hash(await readFile(path.join(root, 'patches/lark-keychain-isolation_test.go'))), storageVerificationSHA256: hash(await readFile(path.join(root, 'patches/lark-storage-isolation_darwin_test.go'))) }, assets };
  const lockPath = path.join(root, 'plugins/feishu-office/.neuxally/auth/assets.lock.json');
  // 部分目标用于增量重建；完整发布必须提供六个平台，禁止伪造缺失摘要。
  let previous = {}; try { previous = JSON.parse(await readFile(lockPath, 'utf8')); } catch { /* 首次构建没有锁文件。 */ }
  if (previous.version === lock.version && previous.source?.patchSHA256 === lock.source.patchSHA256) lock.assets = { ...previous.assets, ...assets };
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
} finally { await rm(work, { recursive: true, force: true }); }
