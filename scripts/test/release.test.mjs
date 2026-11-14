import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';

const root = path.resolve('.');
const packager = process.env.NEUX_PLUGIN_PACKAGER;
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

test('单插件构建沿用真实共享生成器和十端回执', { skip: !packager && 'Set NEUX_PLUGIN_PACKAGER to run the real Go packager integration' }, async t => {
  const { buildRelease } = await import('../build-release.mjs');
  const out = await mkdtemp(path.join(tmpdir(), 'plugin-release-single-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const manifest = JSON.parse(execFileSync('git', ['show', 'HEAD:plugins/github/plugin.json'], { encoding: 'utf8' }));
  const release = await buildRelease({ root, out, sourceCommit, tag: `github@${manifest.version}`, key: 'github', packager });
  assert.equal(release.packager.developmentOverride, true);
  assert.deepEqual(release.packages.map(value => value.key), ['github']);
  const receipt = JSON.parse(await readFile(path.join(out, 'targets/github/artifacts.json'), 'utf8'));
  assert.equal(receipt.sourceID, `${sourceCommit}:plugins/github`);
  assert.equal(receipt.artifacts.length, 10);
  await assert.rejects(stat(path.join(out, 'targets/feishu-office')), { code: 'ENOENT' });
});

test('release script invokes one shared packager and verifies each real self-contained target against its source', { skip: !packager && 'Set NEUX_PLUGIN_PACKAGER to run the real Go packager integration' }, async t => {
  assert.ok(existsSync(path.join(root, 'scripts/build-release.mjs')), 'release builder must exist');
  const { buildRelease } = await import('../build-release.mjs');
  const out = await mkdtemp(path.join(tmpdir(), 'plugin-release-'));t.after(()=>rm(out,{recursive:true,force:true}));
  const sourceCommit = execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  const result = await buildRelease({root,out,sourceCommit,tag:'v0.1.3-dev',packager});
  assert.equal(result.schemaVersion,1);assert.equal(result.sourceCommit,sourceCommit);
  assert.equal(result.packages.length,3);
  const catalog=JSON.parse(await readFile(path.join(out,'catalog.json'),'utf8'));
  assert.doesNotMatch(JSON.stringify(catalog),/readme|skillContent|SKILL\.md|markdown|native-private|gho_/i);
  for(const plugin of result.packages) {
    const entry=catalog.entries.find(value=>value.key===plugin.key);
    assert.equal(plugin.portableSHA256,entry.archiveSHA256);
    const receipt=JSON.parse(await readFile(path.join(out,plugin.receipt),'utf8'));
    assert.equal(receipt.schemaVersion,1);assert.equal(receipt.sourceID,`${sourceCommit}:${entry.packagePath}`);
    assert.equal(receipt.name,entry.name);assert.equal(receipt.version,entry.version);
    assert.match(receipt.sourceDigest,/^[a-f0-9]{64}$/);
    assert.equal(receipt.artifacts.length,10);
    for(const artifact of receipt.artifacts) {
      const archive=path.join(out,'targets',plugin.key,artifact.archive);
      assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'),artifact.archiveSHA256);
      const target=path.join(out,'targets',plugin.key,artifact.directory);
      assert.ok((await stat(path.join(target,'setup.mjs'))).isFile());
      assert.ok((await stat(path.join(target,'.neuxbot/auth/authorize.mjs'))).isFile());
      assert.ok((await stat(path.join(target,'provenance.json'))).isFile());
      assert.ok((await stat(path.join(target,'LICENSE'))).isFile());
      assert.ok((await stat(path.join(target,'NOTICE.md'))).isFile());
      const smoke=execFileSync(process.execPath,[path.join(target,'setup.mjs'),'--profile',artifact.runtime,'--data',path.join(out,'private-smoke',plugin.key,artifact.runtime),'status'],{encoding:'utf8'});
      assert.equal(JSON.parse(smoke).state,'unauthorized');
      if(plugin.key!=='github') assert.ok((await stat(path.join(target,'skills'))).isDirectory());
      if(artifact.runtime==='opencode') {
        const config=JSON.parse(await readFile(path.join(target,'opencode.json'),'utf8'));
        assert.ok(config.mcp.servers);assert.deepEqual(Object.keys(config.mcp),['servers']);
        for(const server of Object.values(config.mcp.servers))assert.ok(!Object.hasOwn(server,'enabled'));
        if(plugin.key==='github')assert.equal(config.mcp.servers.github.headers.Authorization,'{env:GITHUB_PLUGIN_AUTHORIZATION}');
        // No empty executable extension is created for Skill / MCP packages.
        await assert.rejects(stat(path.join(target,'plugin.js')),{code:'ENOENT'});
      }
    }
  }
});
