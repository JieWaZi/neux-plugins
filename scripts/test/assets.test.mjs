import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, chmod, readFile, rm, writeFile, stat, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
const moduleURL = '../../plugins/feishu-office/.neuxally/auth/assets.mjs';
const bytes = Buffer.from('#!/bin/sh\nexit 0\n');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const lock = { schemaVersion: 1, assets: { 'linux-x64': { url: 'https://github.com/JieWaZi/NeuxAlly-Plugins/releases/download/v0.1.0/lark-cli-example', sha256, size: bytes.length } } };

test('按固定摘要下载可执行资产；缓存损坏时重新下载而不执行旧文件', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'plugin-assets-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const { ensureAsset } = await import(moduleURL);
  let calls = 0; const fetcher = async () => { calls++; return new Response(bytes); };
  const options = { dataDirectory: directory, platform: 'linux', arch: 'x64', lock, fetcher };
  const binary = await ensureAsset(options);
  assert.deepEqual(await readFile(binary), bytes); assert.equal((await stat(binary)).mode & 0o777, 0o755);
  assert.equal(await ensureAsset(options), binary); assert.equal(calls, 1);
  await writeFile(binary, 'corrupt');
  assert.equal(await ensureAsset(options), binary); assert.equal(calls, 2);
  assert.deepEqual(await readFile(binary), bytes);
});

test('摘要错误或下载中断不得留下可执行半包，未知平台明确失败', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'plugin-assets-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const { ensureAsset } = await import(moduleURL);
  await assert.rejects(ensureAsset({ dataDirectory: directory, platform: 'linux', arch: 'x64', lock, fetcher: async () => new Response('wrong') }), /digest|size/);
  await assert.rejects(ensureAsset({ dataDirectory: directory, platform: 'linux', arch: 'x64', lock, fetcher: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.subarray(0, 4)); controller.error(new Error('download interrupted')); } })) }), /interrupted/);
  assert.deepEqual(await readdir(path.join(directory, 'cache')), []);
  await assert.rejects(ensureAsset({ dataDirectory: directory, platform: 'unknown', arch: 'unknown', lock }), /unsupported/);
});


test('Windows 资产在独立摘要目录发布官方 lark-cli.exe 名称', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'plugin-assets-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const { ensureAsset } = await import(moduleURL);
  const binary = await ensureAsset({ dataDirectory: directory, platform: 'win32', arch: 'x64', lock: { schemaVersion: 1, assets: { 'win32-x64': lock.assets['linux-x64'] } }, fetcher: async () => new Response(bytes) });
  assert.equal(path.basename(binary), 'lark-cli.exe');
  assert.equal(path.basename(path.dirname(binary)), sha256);
  assert.deepEqual(await readFile(binary), bytes);
});


test('聊天加载缺资产时只创建私有错误命令，实际调用失败且不回退用户全局 CLI', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'plugin-assets-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const { ensureAsset } = await import(moduleURL);
  let downloads = 0;
  const nativeLock = { schemaVersion: 1, assets: { [`${process.platform}-${process.arch}`]: lock.assets['linux-x64'] } };
  const binary = await ensureAsset({ dataDirectory: directory, lock: nativeLock, download: false, fetcher: async () => { downloads++; throw new Error('network forbidden'); } });
  assert.equal(downloads, 0);
  assert.equal(path.isAbsolute(binary), true);
  assert.equal(await ensureAsset({ dataDirectory: directory, lock: nativeLock, download: false }), binary);
  const foreignDirectory = path.join(directory, 'global'); await mkdir(foreignDirectory);
  const marker = path.join(directory, 'foreign-used');
  const foreign = path.join(foreignDirectory, process.platform === 'win32' ? 'lark-cli.cmd' : 'lark-cli');
  await writeFile(foreign, process.platform === 'win32' ? `@echo off\r\necho used>"${marker}"\r\n` : `#!/bin/sh\nprintf used > '${marker.replaceAll("'", "'\\''")}'\n`, { mode: 0o755 });
  const environment = { ...process.env, PATH: `${path.dirname(binary)}${path.delimiter}${foreignDirectory}${path.delimiter}${process.env.PATH ?? ''}` };
  const result = process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/c', 'lark-cli probe'], { env: environment, encoding: 'utf8' })
    : spawnSync('sh', ['-c', 'lark-cli probe'], { env: environment, encoding: 'utf8' });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 127);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /plugin_dependency_unavailable/);
  await assert.rejects(stat(marker), { code: 'ENOENT' });
});

test('聊天加载已安装资产只检查本地文件状态，不读取和重算整个二进制摘要', { skip: process.platform === 'win32' }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'plugin-assets-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const { ensureAsset } = await import(moduleURL);
  const options = { dataDirectory: directory, platform: 'linux', arch: 'x64', lock };
  const binary = await ensureAsset({ ...options, fetcher: async () => new Response(bytes) });
  await chmod(binary, 0o111);
  t.after(() => chmod(binary, 0o755).catch(() => {}));
  const local = await ensureAsset({ ...options, download: false, fetcher: async () => { throw new Error('network forbidden'); } });
  assert.equal(local, binary);
  assert.equal((await stat(binary)).mode & 0o777, 0o111);
});

test('Windows 缺依赖入口同时供原生命令行和 Git Bash 解析，不伪装为 EXE', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'plugin-assets-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const { ensureAsset } = await import(moduleURL);
  const binary = await ensureAsset({ dataDirectory: directory, platform: 'win32', arch: 'x64', lock: { schemaVersion: 1, assets: { 'win32-x64': lock.assets['linux-x64'] } }, download: false });
  assert.equal(path.basename(binary), 'lark-cli.cmd');
  assert.equal((await stat(path.join(path.dirname(binary), 'lark-cli'))).isFile(), true);
  await assert.rejects(stat(path.join(path.dirname(binary), 'lark-cli.exe')), { code: 'ENOENT' });
});
