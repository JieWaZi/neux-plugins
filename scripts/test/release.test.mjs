import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = path.resolve('.');

test('发布标签必须绑定已进入 main 的同一提交', async t => {
  const { verifyPluginTag } = await import('../release-tags.mjs');
  const repo = await mkdtemp(path.join(tmpdir(), 'plugin-release-tag-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'main');
  const first = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', first);
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'tag', '-a', 'github@0.1.0', '-m', 'first');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'unmerged');
  const second = git('rev-parse', 'HEAD');
  git('tag', 'github@0.1.1');
  assert.deepEqual(verifyPluginTag({ root: repo, tag: 'github@0.1.0' }), { key: 'github', version: '0.1.0', sourceCommit: first });
  assert.throws(() => verifyPluginTag({ root: repo, tag: 'github@0.1.0', sourceCommit: second }), /does not identify/);
  assert.throws(() => verifyPluginTag({ root: repo, tag: 'github@0.1.1', sourceCommit: second }), /origin\/main/);
});

test('真实插件快照只构建NeuxBot统一包、详情和轻目录', async t => {
  const { buildReviewSnapshot } = await import('../build-review-snapshot.mjs');
  await mkdir(path.join(root, '.cache'), { recursive: true });
  const out = await mkdtemp(path.join(root, '.cache', 'neuxbot-release-test-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  const result = await buildReviewSnapshot({ root, out });
  const catalog = JSON.parse(await readFile(path.join(out, 'catalog.json'), 'utf8'));
  const expectedFiles = ['catalog.json'];
  assert.equal(result.entries.length, 3);
  for (const entry of catalog.entries) {
    expectedFiles.push(`${entry.key}.zip`, `${entry.key}.details.json`);
    const manifest = JSON.parse(await readFile(path.join(root, entry.packagePath, 'plugin.json'), 'utf8'));
    assert.equal(entry.version, manifest.version);
    const archive = await readFile(path.join(out, `${entry.key}.zip`));
    assert.equal(createHash('sha256').update(archive).digest('hex'), entry.archiveSHA256);
    const files = execFileSync('unzip', ['-Z1', path.join(out, `${entry.key}.zip`)], { encoding: 'utf8' }).trim().split('\n');
    assert.ok(files.includes(`${entry.packagePath}/plugin.json`));
    assert.ok(files.includes(`${entry.packagePath}/.neuxbot/auth/authorize.mjs`));
    assert.ok(files.includes(`${entry.packagePath}/LICENSE`));
    assert.ok(!files.some(name => name === '.agents/plugins/marketplace.json' || name.endsWith('/setup.mjs') || name.endsWith('/native-launch.mjs')));
    const details = await readFile(path.join(out, `${entry.key}.details.json`));
    assert.equal(createHash('sha256').update(details).digest('hex'), entry.detailsSHA256);
    assert.equal(details.length, entry.detailsSize);
  }
  assert.deepEqual((await readdir(out)).sort(), expectedFiles.sort());
});
