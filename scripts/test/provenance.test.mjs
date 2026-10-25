import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validateProvenance } from '../provenance.mjs';

const source = { schemaVersion: 1, upstream: { author: 'Example contributors', repository: 'https://github.com/example/example', license: 'MIT', commit: 'a'.repeat(40), tag: 'v1.2.3', distribution: { mode: 'vendored-source' } }, wrapper: { maintainer: 'NeuxBot contributors', repository: 'https://github.com/JieWaZi/neux-plugins', license: 'MIT', changes: ['Maintained manifest and authorization bridge'] }, dependencies: [], assets: [] };
const validate = data => validateProvenance({ data, packagePath: 'plugins/example', manifest: {}, read: () => { throw new Error('unexpected file read'); } });

test('维护包统一来源结构，业务署名版本直接来自upstream而非包装和授权CLI', async () => {
  for (const key of ['github', 'feishu-office', 'wecom-office']) {
    const base = new URL(`../../plugins/${key}/`, import.meta.url);
    const data = JSON.parse(await readFile(new URL('provenance.json', base), 'utf8'));
    const manifest = JSON.parse(await readFile(new URL('.codex-plugin/plugin.json', base), 'utf8'));
    const files = new Map();
    for (const asset of data.assets ?? []) files.set(`plugins/${key}/${asset.path}`, await readFile(new URL(asset.path, base)));
    for (const dependency of data.dependencies ?? []) files.set(`plugins/${key}/${dependency.lock}`, await readFile(new URL(dependency.lock, base)));
    validateProvenance({ data, packagePath: `plugins/${key}`, manifest, read: name => { assert.ok(files.has(name), name); return files.get(name); } });
    assert.deepEqual(Object.keys(data), ['schemaVersion', 'upstream', 'wrapper', 'dependencies', 'assets']);
    assert.equal(manifest.version, '0.1.0');
    assert.equal(data.wrapper.maintainer, manifest.author.name);
    if (key === 'feishu-office') { assert.equal(data.upstream.author, 'Lark Suite CLI contributors'); assert.equal(data.upstream.tag, 'v1.0.98'); }
    else if (key === 'wecom-office') { assert.equal(data.upstream.author, 'WeCom'); assert.equal(data.upstream.version, '1.3.4'); assert.equal(data.upstream.commit, 'f9b28151dc8d42f703db624fc9b26723c3c93fc5'); }
    else { assert.equal(data.upstream.author, 'GitHub'); assert.equal(data.upstream.distribution.mode, 'hosted-service'); assert.equal(data.upstream.version, undefined); assert.equal(data.upstream.tag, undefined); assert.equal(data.upstream.commit, undefined); assert.match(data.assets[0].sourceURL, /^https:\/\/brand\.github\.com\//); }
    for (const asset of data.assets) assert.equal(createHash('sha256').update(files.get(`plugins/${key}/${asset.path}`)).digest('hex'), asset.sha256);
  }
});

test('统一schema拒绝旧来源分支、无效类型以及中文changes', () => {
  validate(structuredClone(source));
  for (const mutate of [d => d.packaging = {}, d => d.upstream.author = {}, d => d.wrapper.changes = 'text', d => d.wrapper.changes = ['中文'], d => d.upstream.commit = 'main']) {
    const data = structuredClone(source); mutate(data); assert.throws(() => validate(data), /provenance/i);
  }
});

test('固定源码必须有提交，远程服务不得伪造固定服务版本', () => {
  const fixed = structuredClone(source); delete fixed.upstream.commit; assert.throws(() => validate(fixed), /commit/);
  const hosted = structuredClone(source); hosted.upstream.distribution = { mode: 'hosted-service', url: 'https://example.com/mcp' }; assert.throws(() => validate(hosted), /hosted|version|commit/);
  delete hosted.upstream.tag; delete hosted.upstream.commit; validate(hosted);
});

test('图标摘要与依赖锁不符时拒绝发布', () => {
  const data = structuredClone(source); data.assets = [{ path: 'assets/icon.png', sourceURL: 'https://example.com/icon.png', sha256: 'a'.repeat(64), license: 'Brand terms', attribution: 'Example' }];
  assert.throws(() => validateProvenance({ data, packagePath: 'plugins/example', manifest: { interface: { logo: './assets/icon.png' } }, read: () => Buffer.from('wrong') }), /digest|sha256/);
  data.assets = []; data.dependencies = [{ name: 'example-cli', repository: 'https://github.com/example/example', commit: 'a'.repeat(40), version: '1.2.3', license: 'MIT', lock: '.neuxally/auth/assets.lock.json' }];
  assert.throws(() => validateProvenance({ data, packagePath: 'plugins/example', manifest: {}, read: () => Buffer.from(JSON.stringify({ version: '9.9.9', source: { repository: data.dependencies[0].repository, commit: 'a'.repeat(40) } })) }), /lock|version/);
});
