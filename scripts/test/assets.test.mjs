import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
const moduleURL = '../../plugins/feishu-office/.neuxbot/auth/assets.mjs';
const bytes = Buffer.from('#!/bin/sh\nexit 0\n');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const lock = { schemaVersion: 1, assets: { 'linux-x64': { url: 'https://github.com/JieWaZi/neux-plugins/releases/download/v0.1.0/lark-cli-example', sha256, size: bytes.length } } };

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

// 发布位置可随当前 Release 调整；既有程序身份、字节与六平台名称保持固定。
test('飞书固定依赖保留实际发布的版本和六平台资源名', async () => {
  const current = JSON.parse(await readFile(new URL('../../plugins/feishu-office/.neuxbot/auth/assets.lock.json', import.meta.url), 'utf8'));
  const provenance = JSON.parse(await readFile(new URL('../../plugins/feishu-office/provenance.json', import.meta.url), 'utf8'));
  const version = '1.0.98-neuxally.1';
  const release = 'https://github.com/JieWaZi/neux-plugins/releases/download/v0.1.4-providers/';
  assert.equal(current.version, version);
  assert.equal(provenance.dependencies.find(dependency => dependency.name === 'lark-cli').version, version);
  const targets = { 'darwin-arm64': 'darwin-arm64', 'darwin-x64': 'darwin-amd64', 'linux-arm64': 'linux-arm64', 'linux-x64': 'linux-amd64', 'win32-arm64': 'windows-arm64.exe', 'win32-x64': 'windows-amd64.exe' };
  assert.deepEqual(Object.keys(current.assets).sort(), Object.keys(targets).sort());
  for (const [platform, target] of Object.entries(targets)) assert.equal(current.assets[platform].url, `${release}lark-cli-${version}-${target}`);
  assert.equal(current.notices.url, `${release}lark-cli-${version}-NOTICES.txt`);
  assert.match(await readFile(new URL('../build-lark-provider.mjs', import.meta.url), 'utf8'), /const version = '1\.0\.98-neuxally\.1';/);
});
