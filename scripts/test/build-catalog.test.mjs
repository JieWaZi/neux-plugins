import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, symlink, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'plugin-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (name, value) => { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)); };
  await put('plugins/example/.codex-plugin/plugin.json', { name: 'example', version: '0.1.0', description: '示例' });
  await put('plugins/example/provenance.json', { schemaVersion: 1, upstream: { author: 'Example contributors', repository: 'https://github.com/example/example', license: 'MIT', commit: 'a'.repeat(40), tag: 'v1.2.3', distribution: { mode: 'vendored-source' } }, wrapper: { maintainer: 'NeuxBot contributors', repository: 'https://github.com/JieWaZi/neux-plugins', license: 'MIT', changes: ['Maintained package'] }, dependencies: [], assets: [] });
  await put('plugins/example/.mcp.json', { mcpServers: { example: { type: 'http', url: 'https://example.com/mcp' } } });
  await put('plugins/example/assets/reference.txt', 'keep complete package files\n');
  await put('plugins/example/.neuxally/auth/authorize', '#!/bin/sh\nexit 0\n');
  await chmod(path.join(root, 'plugins/example/.neuxally/auth/authorize'), 0o755);
  await put('LICENSE', 'fixture license');
  await put('THIRD_PARTY_NOTICES.md', 'fixture notices');
  execFileSync('git', ['init', '-q', root]);
  const commit = () => { execFileSync('git', ['-C', root, 'add', '.']); execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture']); return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); };
  return { root, put, commit };
}

// 破坏固定快照、完整引用、ZIP 元信息或摘要均应使此真实构建测试失败。
test('构建固定提交的完整可重现 ZIP，记录摘要并保留执行位', async t => {
  const f = await fixture(t); const sourceCommit = f.commit();
  const { buildCatalog } = await import('../build-catalog.mjs');
  const out = path.join(f.root, 'out');
  await mkdir(path.join(out, 'providers'), { recursive: true });
  await writeFile(path.join(out, 'providers/lark-cli'), 'fixed dependency');
  const catalog = await buildCatalog({ root: f.root, out, sourceCommit, tag: 'v0.1.0' });
  assert.equal(await readFile(path.join(out, 'providers/lark-cli'), 'utf8'), 'fixed dependency');
  const archive = await readFile(path.join(out, 'example.zip'));
  assert.equal(catalog.schemaVersion, 2);
  assert.equal(catalog.entries.length, 1);
  assert.equal(catalog.entries[0].sourceCommit, sourceCommit);
  assert.equal(catalog.entries[0].archiveURL, 'https://github.com/JieWaZi/neux-plugins/releases/download/v0.1.0/example.zip');
  assert.equal(catalog.entries[0].packagePath, 'plugins/example');
  assert.equal(catalog.entries[0].archiveSHA256, createHash('sha256').update(archive).digest('hex'));
  const server = createServer(async (request, response) => { try { response.end(await readFile(path.join(out, path.basename(request.url)))); } catch { response.writeHead(404).end(); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const downloadedCatalog = await (await fetch(`${origin}/catalog.json`)).json();
  const downloadedZIP = Buffer.from(await (await fetch(`${origin}${new URL(downloadedCatalog.entries[0].archiveURL).pathname}`)).arrayBuffer());
  assert.equal(createHash('sha256').update(downloadedZIP).digest('hex'), downloadedCatalog.entries[0].archiveSHA256);
  assert.deepEqual(downloadedZIP, archive);
  await f.put('plugins/example/assets/reference.txt', 'dirty tree must never enter snapshot');
  await buildCatalog({ root: f.root, out, sourceCommit, tag: 'v0.1.0' });
  assert.deepEqual(await readFile(path.join(out, 'example.zip')), archive);
  const unpack = path.join(f.root, 'unpack'); await mkdir(unpack);
  execFileSync('unzip', ['-q', path.join(out, 'example.zip'), '-d', unpack]);
  assert.equal(await readFile(path.join(unpack, 'plugins/example/assets/reference.txt'), 'utf8'), 'keep complete package files\n');
  const { stat } = await import('node:fs/promises');
  assert.equal((await stat(path.join(unpack, 'plugins/example/.neuxally/auth/authorize'))).mode & 0o777, 0o755);
});

// 唯一自有包不得退回仅来源引用；失败必须保留之前已完成的产物。
test('拒绝遗留原生引用，不发布不完整包且保留已有产物', async t => {
  const f = await fixture(t); const { buildCatalog } = await import('../build-catalog.mjs');
  const out = path.join(f.root, 'out'); const good = f.commit();
  const catalog = await buildCatalog({ root: f.root, out, sourceCommit: good });
  const archive = await readFile(path.join(out, 'example.zip'));
  await f.put('plugins/example/.neuxally/integration.json', { nativePlugins: { codex: { path: 'codex-plugins/example' } } });
  const bad = f.commit();
  await assert.rejects(buildCatalog({ root: f.root, out, sourceCommit: bad }), /canonical|native reference/i);
  assert.deepEqual(await readFile(path.join(out, 'example.zip')), archive);
  assert.deepEqual(JSON.parse(await readFile(path.join(out, 'catalog.json'), 'utf8')), catalog);
});

test('完整标准包保留MCP声明和可直接使用的Codex本地索引，不读取上游HTTP', async t => {
  const f = await fixture(t); const sourceCommit = f.commit();
  const { buildCatalog } = await import('../build-catalog.mjs'); const out = path.join(f.root, 'out');
  const catalog = await buildCatalog({ root: f.root, out, sourceCommit, fetcher: async () => { throw new Error('upstream HTTP forbidden'); } });
  assert.match(catalog.entries[0].archiveURL, /\/v0\.1\.0\/example\.zip$/);
  const unpack = path.join(f.root, 'native'); await mkdir(unpack); execFileSync('unzip', ['-q', path.join(out, 'example.zip'), '-d', unpack]);
  const index = JSON.parse(await readFile(path.join(unpack, '.agents/plugins/marketplace.json'), 'utf8'));
  assert.equal(index.plugins[0].source.path, './plugins/example');
  const mcp = JSON.parse(await readFile(path.join(unpack, 'plugins/example/.mcp.json'), 'utf8'));
  assert.equal(mcp.mcpServers.example.url, 'https://example.com/mcp');
});

test('拒绝自有包中的符号链接，即使其指向包内', async t => {
  const f = await fixture(t); await symlink('reference.txt', path.join(f.root, 'plugins/example/assets/link'));
  const sourceCommit = f.commit(); const { buildCatalog } = await import('../build-catalog.mjs');
  await assert.rejects(buildCatalog({ root: f.root, out: path.join(f.root, 'out'), sourceCommit }), /symbolic|mode/i);
});

const presentationPNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');

// 删除目录展示派生、错误使用工作区图标或遗漏归档资源，会使安装前可用资料与实际包不一致。
test('固定快照生成安装前双语展示和PNG图标，并保留两种README及包内资产', async t => {
  const f = await fixture(t);
  await f.put('plugins/example/.codex-plugin/plugin.json', { name: 'example', version: '0.1.0', description: 'Review repository changes.', interface: { displayName: 'Example', shortDescription: 'Review repository changes.', logo: './assets/icon.png', composerIcon: './assets/icon.png' } });
  await f.put('plugins/example/.neuxally/presentation.json', { displayNames: { en: 'Example', 'zh-CN': '示例' }, localizedDescriptions: { en: 'Review repository changes.', 'zh-CN': '检查仓库变更。' } });
  await f.put('plugins/example/assets/icon.png', presentationPNG);
  const provenance = JSON.parse(await readFile(path.join(f.root, 'plugins/example/provenance.json'), 'utf8'));
  provenance.assets = [{ path: 'assets/icon.png', sourceURL: 'https://example.com/icon.png', sha256: createHash('sha256').update(presentationPNG).digest('hex'), license: 'Example brand terms', attribution: 'Example' }];
  await f.put('plugins/example/provenance.json', provenance);
  await f.put('plugins/example/README.md', '# Example\nReview repository changes.\n');
  await f.put('plugins/example/README.zh-CN.md', '# 示例\n检查仓库变更。\n');
  const sourceCommit = f.commit();
  await f.put('plugins/example/assets/icon.png', Buffer.from('dirty unsafe asset'));
  const out = path.join(f.root, 'out'); const { buildCatalog } = await import('../build-catalog.mjs');
  const catalog = await buildCatalog({ root: f.root, out, sourceCommit }); const entry = catalog.entries[0];
  assert.equal(entry.name, 'example');
  assert.deepEqual(entry.displayNames, { en: 'Example', 'zh-CN': '示例' });
  assert.deepEqual(entry.localizedDescriptions, { en: 'Review repository changes.', 'zh-CN': '检查仓库变更。' });
  assert.equal(entry.icon, 'data:image/png;base64,' + presentationPNG.toString('base64'));
  const unpack = path.join(f.root, 'unpack-display'); await mkdir(unpack); execFileSync('unzip', ['-q', path.join(out, 'example.zip'), '-d', unpack]);
  assert.deepEqual(await readFile(path.join(unpack, 'plugins/example/assets/icon.png')), presentationPNG);
  assert.equal(await readFile(path.join(unpack, 'plugins/example/README.md'), 'utf8'), '# Example\nReview repository changes.\n');
  assert.equal(await readFile(path.join(unpack, 'plugins/example/README.zh-CN.md'), 'utf8'), '# 示例\n检查仓库变更。\n');
});

for (const [label, file, content, reference] of [
  ['远程图标', 'assets/icon.png', presentationPNG, 'https://example.com/icon.png'],
  ['越界图标', 'assets/icon.png', presentationPNG, './../icon.png'],
  ['伪造PNG', 'assets/icon.png', Buffer.from('<svg onload="alert(1)"/>'), './assets/icon.png'],
  ['截断PNG', 'assets/icon.png', presentationPNG.subarray(0, 30), './assets/icon.png'],
  ['超限PNG', 'assets/icon.png', Buffer.alloc(128 * 1024 + 1), './assets/icon.png'],
  ['超限尺寸', 'assets/icon.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAACAEAAAABCAYAAACl1iXMAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64'), './assets/icon.png'],
  ['非法过滤器', 'assets/icon.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP9z8DwHwAFGQIEfQUW8QAAAABJRU5ErkJggg==', 'base64'), './assets/icon.png'],
  ['不完整像素', 'assets/icon.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGP4DwABAQEAsTj2FAAAAABJRU5ErkJggg==', 'base64'), './assets/icon.png'],
  ['错误块摘要', 'assets/icon.png', Buffer.from(presentationPNG.map((value, index) => index === 29 ? value ^ 1 : value)), './assets/icon.png'],
  ['动态SVG', 'assets/icon.svg', Buffer.from('<svg onload="alert(1)"/>'), './assets/icon.svg'],
]) {
  test(`拒绝发布${label}，不产生可被误用的catalog图标`, async t => {
    const f = await fixture(t);
    await f.put('plugins/example/.codex-plugin/plugin.json', { name: 'example', version: '0.1.0', description: 'Example', interface: { logo: reference } });
    await f.put(`plugins/example/${file}`, content); const sourceCommit = f.commit();
    const { buildCatalog } = await import('../build-catalog.mjs');
    await assert.rejects(buildCatalog({ root: f.root, out: path.join(f.root, 'out'), sourceCommit }), /icon|PNG|asset/i);
    assert.deepEqual(await readdir(path.join(f.root, 'out')).catch(() => []), []);
  });
}

for (const [label, presentation] of [
  ['未知语言', { displayNames: { 'fr': 'Example' } }],
  ['超限翻译', { localizedDescriptions: { en: 'x'.repeat(4097) } }],
  ['非文字翻译', { displayNames: { en: { name: 'Example' } } }],
  ['第二份身份', { name: 'other', displayNames: { en: 'Example' } }],
]) {
  test(`拒绝${label}展示附加文件`, async t => {
    const f = await fixture(t); await f.put('plugins/example/.neuxally/presentation.json', presentation); const sourceCommit = f.commit();
    const { buildCatalog } = await import('../build-catalog.mjs');
    await assert.rejects(buildCatalog({ root: f.root, out: path.join(f.root, 'out'), sourceCommit }), /presentation|locale|display/i);
  });
}


test('拒绝通过符号链接读取图标', async t => {
  const f = await fixture(t);
  await f.put('plugins/example/.codex-plugin/plugin.json', { name: 'example', version: '0.1.0', description: 'Example', interface: { logo: './assets/icon.png' } });
  await f.put('plugins/example/assets/real.png', presentationPNG);
  await symlink('real.png', path.join(f.root, 'plugins/example/assets/icon.png'));
  const sourceCommit = f.commit(); const { buildCatalog } = await import('../build-catalog.mjs');
  await assert.rejects(buildCatalog({ root: f.root, out: path.join(f.root, 'out'), sourceCommit }), /mode|icon/i);
});

// 缺失或伪造来源不能发布，且不破坏上一次完成的目录。
test('缺失或异构来源被构建入口拒绝，完整包保留统一来源', async t => {
  const f = await fixture(t); const sourceCommit = f.commit();
  const { buildCatalog } = await import('../build-catalog.mjs'); const out = path.join(f.root, 'out');
  const catalog = await buildCatalog({ root: f.root, out, sourceCommit });
  const archive = await readFile(path.join(out, 'example.zip'));
  const unpack = path.join(f.root, 'provenance-unpack'); await mkdir(unpack); execFileSync('unzip', ['-q', path.join(out, 'example.zip'), '-d', unpack]);
  assert.equal(JSON.parse(await readFile(path.join(unpack, 'plugins/example/provenance.json'), 'utf8')).upstream.tag, 'v1.2.3');
  await rm(path.join(f.root, 'plugins/example/provenance.json'));
  await assert.rejects(buildCatalog({ root: f.root, out, sourceCommit: f.commit() }), /provenance/);
  await f.put('plugins/example/provenance.json', { packaging: { author: 'Wrong shape' } });
  await assert.rejects(buildCatalog({ root: f.root, out, sourceCommit: f.commit() }), /provenance/);
  assert.deepEqual(await readFile(path.join(out, 'example.zip')), archive);
  assert.deepEqual(JSON.parse(await readFile(path.join(out, 'catalog.json'), 'utf8')), catalog);
});

// 展示侧车的摘要、固定快照和技能原文由真实构建入口验证，不借安装包展开。
test('固定快照独立生成只读资料侧车，目录校验绑定完整ZIP且可重现', async t => {
  const f=await fixture(t), skill='---\nname: example\ndescription: |\n  First line.\n  Second line.\n---\n\n# Original skill\n';
  await f.put('plugins/example/README.md','# Example\nEnglish.\n');await f.put('plugins/example/README.zh-CN.md','# 示例\n中文。\n');await f.put('plugins/example/skills/example/SKILL.md',skill);
  const sourceCommit=f.commit(),out=path.join(f.root,'out');const {buildCatalog}=await import('../build-catalog.mjs');
  const catalog=await buildCatalog({root:f.root,out,sourceCommit});const e=catalog.entries[0];
  assert.equal(e.detailsURL,'https://github.com/JieWaZi/neux-plugins/releases/download/v0.1.0/example.details.json');
  const raw=await readFile(path.join(out,'example.details.json'));assert.equal(e.detailsSize,raw.length);assert.equal(e.detailsSHA256,createHash('sha256').update(raw).digest('hex'));
  const d=JSON.parse(raw);assert.equal(d.sourceCommit,e.sourceCommit);assert.equal(d.archiveSHA256,e.archiveSHA256);assert.equal(d.packagePath,e.packagePath);assert.equal(d.package.manifest.name,e.name);assert.equal(d.package.manifest.version,e.version);
  assert.equal(d.readmes.en,'# Example\nEnglish.\n');assert.equal(d.readmes['zh-CN'],'# 示例\n中文。\n');assert.equal(d.skillContents['skills/example'],skill);
  assert.equal(d.package.skills[0].description,'First line.\nSecond line.\n');assert.deepEqual(d.package.servers,[{key:'example',type:'streamable-http',url:'https://example.com/mcp'}]);
  await f.put('plugins/example/README.md','dirty readme');await f.put('plugins/example/skills/example/SKILL.md','dirty skill');
  await buildCatalog({root:f.root,out,sourceCommit});assert.deepEqual(await readFile(path.join(out,'example.details.json')),raw);
});
