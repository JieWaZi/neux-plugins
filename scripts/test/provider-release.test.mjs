import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'provider-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assets = path.join(root, 'assets');
  await mkdir(assets);
  const originals = [];
  for (const key of ['feishu-office', 'github']) {
    const directory = path.join(root, 'plugins', key, '.neuxbot/auth');
    await mkdir(directory, { recursive: true });
    const binary = Buffer.from(`${key}:verified program`), notices = Buffer.from(`${key}:license`);
    const bind = (name, bytes) => ({ url: `https://github.com/JieWaZi/neux-plugins/releases/download/v0.1.0/${name}`, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length });
    const lock = { schemaVersion: 1, version: 'fixed-provider', source: { commit: 'a'.repeat(40) },
      notices: bind(`${key}-NOTICES.txt`, notices), assets: { 'linux-x64': bind(`${key}-linux-amd64`, binary) } };
    await writeFile(path.join(assets, `${key}-linux-amd64`), binary);
    await writeFile(path.join(assets, `${key}-NOTICES.txt`), notices);
    const filename = path.join(directory, 'assets.lock.json');
    await writeFile(filename, `${JSON.stringify(lock, null, 2)}\n`);
    originals.push({ filename, lock });
  }
  return { root, assets, originals };
}

test('current release rebinding preserves verified provider identity and bytes', async t => {
  const { retargetProviderAssets } = await import('../prepare-provider-release.mjs');
  const f = await fixture(t);
  await retargetProviderAssets({ root: f.root, assets: f.assets, tag: 'v0.1.3' });
  for (const { filename, lock } of f.originals) {
    const actual = JSON.parse(await readFile(filename, 'utf8'));
    assert.equal(actual.version, lock.version);
    assert.deepEqual(actual.source, lock.source);
    for (const [old, next] of [[lock.notices, actual.notices], [lock.assets['linux-x64'], actual.assets['linux-x64']]]) {
      assert.equal(next.url, `https://github.com/JieWaZi/neux-plugins/releases/download/v0.1.3/${path.basename(old.url)}`);
      assert.equal(next.sha256, old.sha256);
      assert.equal(next.size, old.size);
    }
  }
});

test('a mismatched provider prevents either lock from being rebound', async t => {
  const { retargetProviderAssets } = await import('../prepare-provider-release.mjs');
  const f = await fixture(t);
  await writeFile(path.join(f.assets, 'github-linux-amd64'), 'tampered');
  await assert.rejects(retargetProviderAssets({ root: f.root, assets: f.assets, tag: 'v0.1.3' }), /digest|size/);
  for (const { filename, lock } of f.originals) assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), lock);
});

test('rebinding requires a fixed release and the existing maintained asset origin', async t => {
  const { retargetProviderAssets } = await import('../prepare-provider-release.mjs');
  const f = await fixture(t);
  for (const tag of ['latest', '../v0.1.3', 'v0.1.3?token=secret']) {
    await assert.rejects(retargetProviderAssets({ root: f.root, assets: f.assets, tag }), /release tag/);
  }
  const { filename, lock } = f.originals[0];
  lock.notices.url = 'https://example.invalid/untrusted.txt';
  await writeFile(filename, JSON.stringify(lock));
  await assert.rejects(retargetProviderAssets({ root: f.root, assets: f.assets, tag: 'v0.1.3' }), /asset URL/);
});
