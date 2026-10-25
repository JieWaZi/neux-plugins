import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assetFilename, buildAssetLock, buildGitHubProvider, targets } from '../build-github-provider.mjs';

test('发布锁来自六个真实资产字节，缺少平台不生成完整锁', async t => {
 const directory=await mkdtemp(path.join(tmpdir(),'gh-build-lock-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const root=path.join(directory,'repo'), output=path.join(directory,'assets');await mkdir(path.join(root,'patches'),{recursive:true});await mkdir(output);
 await writeFile(path.join(root,'patches/github-keyring-isolation.patch'),'actual patch');await writeFile(path.join(root,'patches/github-keyring-isolation_test.go'),'actual verification');
 await assert.rejects(buildAssetLock({root,output,notices:'original license text'}),/ENOENT/);
 for(const target of targets) await writeFile(path.join(output,assetFilename(target)),Buffer.from(`binary:${target}`));
 const lock=await buildAssetLock({root,output,notices:'original license text'});
 assert.equal(Object.keys(lock.assets).length,6);
 const bytes=await readFile(path.join(output,assetFilename('darwin-arm64')));
 assert.deepEqual(lock.assets['darwin-arm64'],{url:`https://github.com/JieWaZi/neux-plugins/releases/download/v0.1.0/${assetFilename('darwin-arm64')}`,sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length});
 assert.equal(lock.version,'2.102.0-neuxally.2');
 assert.match(lock.assets['win32-x64'].url,/windows-amd64\.exe$/);
 assert.equal(lock.source.patchSHA256,createHash('sha256').update('actual patch').digest('hex'));
 assert.equal(lock.notices.sha256,createHash('sha256').update('original license text').digest('hex'));
});

test('非法目标不能成为路径或构建参数',()=>{
 for(const target of ['../escape','linux-riscv64','windows-arm64/evil','darwin-x64'])assert.throws(()=>assetFilename(target),/unsupported/);
});


test('源码摘要失败保留上次发布锁与资产，不执行未核验源码',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'gh-build-source-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const auth=path.join(root,'plugins/github/.neuxally/auth'),output=path.join(root,'dist/providers');
 await mkdir(auth,{recursive:true});await mkdir(output,{recursive:true});
 await writeFile(path.join(auth,'assets.lock.json'),'previous lock');await writeFile(path.join(output,'previous-bin'),'previous bytes');
 const archive=path.join(root,'source.tar.gz');await writeFile(archive,'not the pinned source');
 await assert.rejects(buildGitHubProvider({root,sourceArchive:archive}),/source digest mismatch/);
 assert.equal(await readFile(path.join(auth,'assets.lock.json'),'utf8'),'previous lock');
 assert.equal(await readFile(path.join(output,'previous-bin'),'utf8'),'previous bytes');
});
