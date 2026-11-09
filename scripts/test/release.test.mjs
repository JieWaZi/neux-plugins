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
        assert.equal(artifact.profile,'opencode-v2/1');
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
