import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repo = 'JieWaZi/neux-plugins';
const releases = `/repos/${repo}/releases`;
const sourceCommit = 'a'.repeat(40);
const bytes = value => Buffer.from(JSON.stringify(value));
const sha = content => createHash('sha256').update(content).digest('hex');
const fixed = (tag, name) => `https://github.com/${repo}/releases/download/${tag}/${name}`;

function entry(key, version, tag, commit = sourceCommit) {
  return {
    key, name: key, version, description: 'A plugin', packagePath: `plugins/${key}`, format: 'agent-plugins',
    sourceCommit: commit, archiveURL: fixed(tag, `${key}.zip`), archiveSHA256: sha(Buffer.from('portable package')),
    detailsURL: fixed(tag, `${key}.details.json`), detailsSHA256: sha(Buffer.from('{}')), detailsSize: 2,
  };
}

const original = {
  schemaVersion: 1,
  entries: [entry('feishu-office', '0.1.1', 'v0.1.3', 'b'.repeat(40)), entry('github', '0.1.1', 'v0.1.3', 'b'.repeat(40))],
};
const candidate = entry('github', '0.1.2', 'github@0.1.2');

async function buildFixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'publish-plugin-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const put = (name, value) => writeFile(path.join(directory, name), typeof value === 'string' ? value : bytes(value));
  const runtimes = ['codex', 'claude', 'cursor', 'workbuddy', 'qoder', 'kimi', 'gemini', 'grok', 'opencode', 'pi'];
  const artifacts = runtimes.map(runtime => {
    const name = `github-${runtime}`;
    return { runtime, directory: name, archive: `${name}.zip`, archiveSHA256: sha(Buffer.from(name)), contentDigest: 'c'.repeat(64) };
  });
  const lock = JSON.parse(await readFile(new URL('../packager.lock.json', import.meta.url), 'utf8'));
  const packager = {
    generatorVersion: lock.generatorVersion, binarySHA256: 'e'.repeat(64), developmentOverride: false,
    source: { repository: lock.repository, commit: lock.source.commit, goVersion: lock.source.goVersion },
  };
  const receipt = { schemaVersion: 1, sourceID: `${sourceCommit}:plugins/github`, sourceDigest: 'd'.repeat(64), name: 'github', version: '0.1.2', artifacts };
  await mkdir(path.join(directory, 'targets/github'), { recursive: true });
  await Promise.all([
    put('catalog.json', { schemaVersion: 1, entries: [candidate] }),
    put('github.zip', 'portable package'),
    put('github.details.json', '{}'),
    put('targets/github/artifacts.json', receipt),
    put('release.json', {
      schemaVersion: 1, tag: 'github@0.1.2', sourceCommit, packager,
      packages: [{ key: 'github', sourceID: receipt.sourceID, sourceDigest: receipt.sourceDigest, portableArchive: 'github.zip', portableSHA256: candidate.archiveSHA256, receipt: 'targets/github/artifacts.json' }],
    }),
    ...artifacts.map(artifact => put(`targets/github/${artifact.archive}`, artifact.directory)),
  ]);
  return directory;
}

// 在 HTTP 边界模拟草稿、Latest 指针、公开下载与失败上传。
async function remote() {
  const { GitHubReleases } = await import('../github-releases.mjs');
  const state = {
    releases: new Map(),
    files: new Map(),
    writes: [],
    reads: [],
    nextID: 1,
    latest: 'v0.1.3',
    tagCommit: sourceCommit,
    failLatestDownload: false,
    failUpload: '',
    losePublishResponse: '',
    publishReadLag: new Map(),
  };
  function attach(release, name, content, assetState = 'uploaded') {
    const asset = {
      id: state.nextID++, name, state: assetState, size: content.length,
      digest: assetState === 'uploaded' ? `sha256:${sha(content)}` : null,
      browser_download_url: fixed(release.tag_name, name),
    };
    release.assets.push(asset);
    state.files.set(asset.id, content);
    return asset;
  }
  function makeRelease({ tag_name, name = tag_name, draft = false, prerelease = false, target_commitish = sourceCommit, body = '' }) {
    const release = { id: state.nextID++, tag_name, name, draft, prerelease, target_commitish, body, assets: [] };
    state.releases.set(tag_name, release);
    return release;
  }
  const latest = makeRelease({ tag_name: 'v0.1.3' });
  const json = (payload, status = 200) => Response.json(payload, { status });
  const missing = () => json({ message: 'Not found' }, 404);
  const fetcher = async (input, options) => {
    const url = new URL(input), requestPath = url.pathname, method = options.method ?? 'GET';
    if (method === 'GET') state.reads.push(input.toString());
    else state.writes.push({ method, requestPath, data: url.host === 'api.github.com' && options.body ? JSON.parse(options.body) : undefined });
    if (url.host === 'github.com') {
      assert.equal(options.headers?.Authorization, undefined, 'browser URL must not receive the write token');
      const [, tag, name] = /\/releases\/(?:download\/([^/]+)|latest\/download)\/([^/]+)$/.exec(requestPath);
      if (!tag && state.failLatestDownload) return json({}, 503);
      const release = state.releases.get(tag ?? state.latest);
      const asset = !release?.draft && release?.assets.find(asset => asset.name === name && asset.state === 'uploaded');
      return asset ? new Response(state.files.get(asset.id)) : missing();
    }
    if (url.host === 'uploads.github.com') {
      const id = Number(requestPath.match(/\/(\d+)\/assets$/)[1]);
      const release = [...state.releases.values()].find(value => value.id === id);
      const name = url.searchParams.get('name');
      assert.ok(release.draft);
      assert.ok(!release.assets.some(asset => asset.name === name));
      if (state.failUpload === name) {
        state.failUpload = '';
        attach(release, name, Buffer.alloc(0), 'starter');
        return json({}, 502);
      }
      return json(attach(release, name, Buffer.from(options.body)), 201);
    }
    assert.equal(url.host, 'api.github.com');
    if (requestPath.startsWith(`/repos/${repo}/commits/`)) return json({ sha: state.tagCommit });
    if (requestPath === `${releases}/latest`) return json(state.releases.get(state.latest));
    if (requestPath.startsWith(`${releases}/tags/`)) {
      const release = state.releases.get(decodeURIComponent(requestPath.slice(`${releases}/tags/`.length)));
      return release && !release.draft ? json(release) : missing();
    }
    if (method === 'GET' && requestPath === releases) return json([...state.releases.values()]);
    if (method === 'GET' && requestPath.startsWith(`${releases}/`)) {
      const release = [...state.releases.values()].find(value => value.id === Number(path.basename(requestPath)));
      const lag = state.publishReadLag.get(release?.id) ?? 0;
      if (lag > 0) {
        state.publishReadLag.set(release.id, lag - 1);
        return json({ ...release, draft: true });
      }
      return release ? json(release) : missing();
    }
    if (method === 'POST' && requestPath === releases) return json(makeRelease(JSON.parse(options.body)), 201);
    if (method === 'DELETE' && requestPath.startsWith(`${releases}/assets/`)) {
      const assetID = Number(path.basename(requestPath));
      const release = [...state.releases.values()].find(value => value.assets.some(asset => asset.id === assetID));
      assert.ok(release.draft);
      release.assets = release.assets.filter(asset => asset.id !== assetID);
      return new Response(null, { status: 204 });
    }
    if (method === 'PATCH' && requestPath.startsWith(`${releases}/`)) {
      const release = [...state.releases.values()].find(value => value.id === Number(path.basename(requestPath)));
      const { draft, make_latest } = JSON.parse(options.body);
      assert.equal(draft, false);
      assert.ok(release.draft && release.assets.every(asset => asset.state === 'uploaded'));
      release.draft = false;
      if (make_latest === 'true') state.latest = release.tag_name;
      if (state.losePublishResponse === release.tag_name) {
        state.publishReadLag.set(release.id, 2);
        throw new TypeError('connection reset after publishing');
      }
      return json(release);
    }
    assert.fail(`unexpected GitHub request: ${method} ${requestPath}`);
  };
  return {
    state, api: new GitHubReleases({ token: 'fixture', fetcher, wait: async () => {} }),
    seed: (catalog) => {
      latest.assets.length = 0;
      return attach(latest, 'catalog.json', bytes(catalog));
    },
    catalog: () => JSON.parse(state.files.get(state.releases.get(state.latest).assets.find(asset => asset.name === 'catalog.json').id)),
  };
}

const options = { tag: 'github@0.1.2', sourceCommit, catalogTag: 'catalog-123-1' };

test('目录合并保留其他条目并按稳定 SemVer 拒绝降级或同版本换包', async () => {
  const { mergeCatalog } = await import('../release-catalog.mjs');
  const expected = { schemaVersion: 1, entries: [original.entries[0], candidate] };
  assert.deepEqual(mergeCatalog(original, candidate), { status: 'changed', catalog: expected });
  assert.deepEqual(mergeCatalog(expected, candidate), { status: 'current', catalog: expected });
  const ahead = { schemaVersion: 1, entries: [original.entries[0], entry('github', '0.1.10', 'github@0.1.10')] };
  assert.deepEqual(mergeCatalog(ahead, candidate), { status: 'superseded', catalog: ahead });
  assert.throws(() => mergeCatalog(expected, { ...candidate, archiveSHA256: 'f'.repeat(64) }), /immutable binding conflict/);
  assert.throws(() => mergeCatalog({ schemaVersion: 1, entries: [original.entries[0], original.entries[0]] }, candidate), /duplicate catalog key/);
  assert.throws(() => mergeCatalog({ schemaVersion: 1, entries: [{ ...original.entries[0], archiveURL: fixed('latest', 'feishu-office.zip') }] }, candidate), /fixed archive/);
});

test('独立 Release 先验证固定工件，再以一次更新提升完整 Latest 目录', async t => {
  const { publishPlugin, promoteCatalog } = await import('../publish-plugin.mjs');
  const directory = await buildFixture(t);
  const { api, state, seed, catalog } = await remote();
  seed(original);
  await publishPlugin({ api, directory, ...options });
  assert.equal(state.latest, 'v0.1.3');
  const published = state.releases.get(options.tag);
  assert.equal(published.draft, false);
  assert.equal(published.assets.length, 15);
  assert.ok(published.assets.some(asset => asset.name === 'entry.json'));
  assert.ok(published.assets.every(asset => state.reads.includes(asset.browser_download_url)));
  assert.deepEqual(state.writes.filter(write => write.method === 'PATCH').map(write => write.data), [{ draft: false, make_latest: 'false' }]);
  assert.equal(await promoteCatalog({ api, ...options }), 'changed');
  assert.equal(state.latest, 'catalog-123-1');
  assert.equal(state.releases.get(state.latest).target_commitish, 'main');
  assert.deepEqual(catalog().entries, [original.entries[0], candidate]);
  assert.ok(state.reads.includes(fixed('v0.1.3', 'catalog.json')));
  assert.ok(state.reads.includes(fixed('catalog-123-1', 'catalog.json')));
  assert.ok(state.reads.includes(`https://github.com/${repo}/releases/latest/download/catalog.json`));
  assert.deepEqual(state.writes.filter(write => write.method === 'PATCH').map(write => write.data), [
    { draft: false, make_latest: 'false' }, { draft: false, make_latest: 'true' },
  ]);
  const writes = state.writes.length;
  await publishPlugin({ api, directory, ...options });
  assert.equal(await promoteCatalog({ api, ...options, catalogTag: 'catalog-123-2' }), 'current');
  assert.equal(state.writes.length, writes);
});

test('失败上传保留草稿并安全补齐，已发布资产摘要冲突时停止写入', async t => {
  const { publishPlugin } = await import('../publish-plugin.mjs');
  const directory = await buildFixture(t);
  const { api, state, seed } = await remote();
  seed(original);
  state.failUpload = 'github.zip';
  await assert.rejects(publishPlugin({ api, directory, ...options }), /502/);
  const plugin = state.releases.get(options.tag);
  assert.equal(plugin.draft, true);
  assert.equal(state.latest, 'v0.1.3');
  const prior = plugin.assets.find(asset => asset.state === 'uploaded');
  await publishPlugin({ api, directory, ...options });
  assert.equal(plugin.draft, false);
  assert.ok(plugin.assets.some(asset => asset.id === prior.id));
  const published = plugin.assets.find(asset => asset.name === 'github.zip');
  published.digest = `sha256:${'f'.repeat(64)}`;
  const writes = state.writes.length;
  await assert.rejects(publishPlugin({ api, directory, ...options }), /immutable release asset conflict/);
  assert.equal(state.writes.length, writes);
});

test('Latest 回读失败后重试使用实际发布状态，损坏的基线和旧候选不会提升目录', async t => {
  const { publishPlugin, promoteCatalog } = await import('../publish-plugin.mjs');
  const directory = await buildFixture(t);
  const { api, state, seed } = await remote();
  const oldAsset = seed(original);
  await publishPlugin({ api, directory, ...options });
  const writes = state.writes.length;
  state.files.set(oldAsset.id, bytes({ ...original, entries: [] }));
  await assert.rejects(promoteCatalog({ api, ...options }), /release asset digest/);
  assert.equal(state.writes.length, writes);
  seed({ schemaVersion: 1, entries: [original.entries[0], entry('github', '0.1.10', 'github@0.1.10')] });
  assert.equal(await promoteCatalog({ api, ...options }), 'superseded');
  assert.equal(state.writes.length, writes);
  seed(original);
  state.failLatestDownload = true;
  await assert.rejects(promoteCatalog({ api, ...options }), /503/);
  assert.equal(state.latest, 'catalog-123-1');
  state.failLatestDownload = false;
  const afterPromotion = state.writes.length;
  assert.equal(await promoteCatalog({ api, ...options, catalogTag: 'catalog-123-2' }), 'current');
  assert.equal(state.writes.length, afterPromotion);
});

test('固定标签被移动或本地构建资产损坏时，发布入口不会创建草稿', async t => {
  const { publishPlugin } = await import('../publish-plugin.mjs');
  const directory = await buildFixture(t);
  const { api, state } = await remote();
  state.tagCommit = 'b'.repeat(40);
  await assert.rejects(publishPlugin({ api, directory, ...options }), /tag .* does not identify/);
  assert.equal(state.writes.length, 0);
  state.tagCommit = sourceCommit;
  await writeFile(path.join(directory, 'github.zip'), 'corrupt portable archive');
  await assert.rejects(publishPlugin({ api, directory, ...options }), /built asset digest/);
  assert.equal(state.writes.length, 0);
});

test('与旧目录同版本但绑定不同的独立插件无法创建草稿', async t => {
  const { publishPlugin } = await import('../publish-plugin.mjs');
  const directory = await buildFixture(t);
  const { api, state, seed } = await remote();
  seed({ schemaVersion: 1, entries: [original.entries[0], entry('github', '0.1.2', 'v0.1.3')] });
  await assert.rejects(publishPlugin({ api, directory, ...options }), /immutable binding conflict/);
  assert.equal(state.writes.length, 0);
});

test('目录已有新版本时只允许恢复既有旧版发布', async t => {
  const { publishPlugin } = await import('../publish-plugin.mjs');
  const directory = await buildFixture(t);
  const { api, state, seed } = await remote();
  const newer = { schemaVersion: 1, entries: [original.entries[0], entry('github', '0.1.10', 'github@0.1.10')] };
  seed(newer);
  await assert.rejects(publishPlugin({ api, directory, ...options }), /superseded/);
  assert.equal(state.writes.length, 0);
  seed(original);
  state.failUpload = 'github.zip';
  await assert.rejects(publishPlugin({ api, directory, ...options }), /502/);
  seed(newer);
  await publishPlugin({ api, directory, ...options });
  assert.equal(state.releases.get(options.tag).draft, false);
  assert.equal(state.latest, 'v0.1.3');
});

test('发布 PATCH 响应丢失时回读同一个 Release 并完成 Latest 核验', async t => {
  const { publishPlugin, promoteCatalog } = await import('../publish-plugin.mjs');
  const directory = await buildFixture(t);
  const { api, state, seed, catalog } = await remote();
  seed(original);
  await publishPlugin({ api, directory, ...options });
  state.losePublishResponse = 'catalog-123-1';
  assert.equal(await promoteCatalog({ api, ...options }), 'changed');
  assert.equal(state.latest, 'catalog-123-1');
  const { id } = state.releases.get(state.latest);
  assert.equal(state.publishReadLag.get(id), 0);
  assert.equal(state.writes.filter(write => write.method === 'PATCH' && write.requestPath === `${releases}/${id}`).length, 1);
  assert.deepEqual(catalog().entries, [original.entries[0], candidate]);
});
