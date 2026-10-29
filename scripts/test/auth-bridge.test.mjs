import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';

// 外部边界替代真实网络和账号，真实桥接进程负责协议、隔离、状态核验和取消。
async function bridge(t, scenario = 'success', options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'plugin-auth-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = path.join(directory, options.overrideName ?? 'lark-cli');
  await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs');const path=require('node:path');const args=process.argv.slice(2); const p=process.env.LARKSUITE_CLI_CONFIG_DIR;
if (process.env.LARKSUITE_CLI_ACCESS_TOKEN) process.exit(19);
fs.mkdirSync(p,{recursive:true});
const flag=path.join(p,'authorized');
if(args[0]==='config'){process.stderr.write('https://open.feishu.cn.evil.example/page/cli?user_code=bad\\n');process.stderr.write('https://open.feishu.cn/page/cli?user_code=APP-EXAMPLE\\n');${scenario === 'cancel-initial' ? "setInterval(()=>{},1000);process.on('SIGTERM',()=>{fs.writeFileSync(path.join(p,'stopped-initial'),'yes');process.exit(0)});" : "fs.writeFileSync(path.join(p,'config.json'),'{}');"}}
else if(args[1]==='status' && ${scenario === 'offline-resolve'}){fs.writeFileSync(path.join(p,'unexpected-status'),'yes');process.exit(74);}
else if(args[1]==='status' && ${['app-only', 'two-stage-app-only'].includes(scenario)} && !fs.existsSync(flag)){console.log(JSON.stringify({appId:'cli_example',identities:{}}));}
else if(args[1]==='status'){console.log(JSON.stringify({appId:'cli_example',identities:{user:{available:fs.existsSync(flag),verified:${scenario !== 'unverified'},openId:'ou_example',userName:'示例账号',scope:${JSON.stringify(scenario === 'missing-scope' ? 'offline_access' : 'offline_access docx:document')}}}}));}
else if(args.includes('--no-wait'))console.log(JSON.stringify({verification_url:'https://open.feishu.cn/auth/device?code=USER-EXAMPLE',device_code:'PRIVATE-DEVICE-TOKEN',expires_in:${scenario === 'expired' ? 1 : 600}}));
else if(args.includes('--device-code')){${scenario === 'two-stage-app-only' ? "const wait=setInterval(()=>{if(fs.existsSync(path.join(p,'complete-user'))){clearInterval(wait);fs.writeFileSync(flag,'yes');console.log(JSON.stringify({event:'authorization_complete',missing:[]}));}},20);" : ['cancel', 'expired'].includes(scenario) ? "setInterval(()=>{},1000);process.on('SIGTERM',()=>{fs.writeFileSync(path.join(p,'stopped'),'yes');process.exit(0)});" : "fs.writeFileSync(flag,'yes');console.log(JSON.stringify({event:'authorization_complete',missing:[]}));"}}
else if(args[1]==='logout'){fs.rmSync(flag,{force:true});}
else if(args[0]==='probe')console.log('MANAGED:'+p);
else process.exit(20);
`);
  await chmod(binary, 0o755);
  const foreignDirectory = path.join(directory, 'user-bin'); await mkdir(foreignDirectory);
  const foreignMarker = path.join(directory, 'used-global-cli');
  const foreignBinary = path.join(foreignDirectory, 'lark-cli');
  await writeFile(foreignBinary, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(foreignMarker)},'used'); console.log('USER-GLOBAL');`); await chmod(foreignBinary, 0o755);
  let script = path.resolve('plugins/feishu-office/.neuxally/auth/authorize.mjs'); let nodeArgs = [];
  if (options.downloaded || options.presentation) {
    // 只替代 HTTP 响应；资产校验/缓存、桥接、私密 resolve 和最终命令查找均运行真实代码。
    const fixturePackage = path.join(directory, 'package'); const authDirectory = path.join(fixturePackage, '.neuxally/auth');
    await cp(path.dirname(script), authDirectory, { recursive: true });
    if (options.presentation) await writeFile(path.join(authDirectory, 'presentation.json'), JSON.stringify(options.presentation));
    await cp(path.resolve('plugins/feishu-office/.neuxally/integration.json'), path.join(fixturePackage, '.neuxally/integration.json'));
    await mkdir(path.join(fixturePackage, 'skills/lark-doc'), { recursive: true });
    await cp(path.resolve('plugins/feishu-office/skills/lark-doc/SKILL.md'), path.join(fixturePackage, 'skills/lark-doc/SKILL.md'));
    const content = await readFile(binary); const digest = createHash('sha256').update(content).digest('hex');
    await writeFile(path.join(authDirectory, 'assets.lock.json'), JSON.stringify({ schemaVersion: 1, assets: { [`${process.platform}-${process.arch}`]: { url: 'https://github.com/example/release/lark-cli', sha256: digest, size: content.length } } }));
    const preload = path.join(directory, 'http-response.mjs');
    await writeFile(preload, `import { readFile } from 'node:fs/promises';globalThis.fetch=async()=>new Response(await readFile(${JSON.stringify(binary)}));`);
    script = path.join(authDirectory, 'authorize.mjs'); nodeArgs = ['--import', preload];
  }
  if (['app-only', 'offline-resolve'].includes(scenario)) { await mkdir(path.join(directory, 'private/profile'), { recursive: true }); await writeFile(path.join(directory, 'private/profile/config.json'), '{}'); }
  const child = spawn(process.execPath, [...nodeArgs, script], { env: { ...process.env, PATH: `${foreignDirectory}${path.delimiter}${process.env.PATH ?? ''}`, NEUXALLY_LARK_CLI: options.downloaded ? '' : binary, LARKSUITE_CLI_ACCESS_TOKEN: 'INHERITED-SECRET', LARKSUITE_CLI_CONFIG_DIR: '/do-not-touch' }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const messages = [], pending = new Map(); let next = 1; let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  createInterface({ input: child.stdout }).on('line', line => { const value = JSON.parse(line); messages.push(value); if (value.id != null) { pending.get(value.id)?.(value); pending.delete(value.id); } });
  const params = { sessionId: 'session-example', pluginId: 'plugin-example', dataDirectory: path.join(directory, 'private'), scopes: ['offline_access', 'docx:document'] };
  const request = (method, extra = {}) => new Promise((resolve, reject) => { const id = next++; const timer = setTimeout(() => reject(new Error(`request timeout: ${method}; ${stderr}`)), 3000); pending.set(id, value => { clearTimeout(timer); resolve(value); }); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, ...extra } })}\n`); });
  const waitState = async state => { for(let i=0;i<150;i++){const found=messages.find(x=>x.method==='auth/state' && x.params.state===state);if(found)return found; await new Promise(resolve=>setTimeout(resolve,20));}throw new Error(`no ${state}: ${JSON.stringify(messages)} ${stderr}`); };
  return { directory, foreignMarker, params, request, waitState, messages, stderr: () => stderr };
}

test('多阶段挑战动态更新；真实验证成功后按组件私密 resolve', async t => {
  const f = await bridge(t);
  assert.equal((await f.request('auth/start')).result.state, 'pending');
  const final = await f.waitState('authorized'); assert.equal(final.params.account.name, '示例账号');
  const challenges = f.messages.filter(x => x.method === 'auth/challenge');
  assert.equal(challenges.length, 2);
  assert.notEqual(challenges[0].params.challengeId, challenges[1].params.challengeId);
  assert.match(challenges[0].params.actions[0].url, /^https:\/\/open\.feishu\.cn\/page\/cli/);
  assert.ok(challenges[0].params.notice);
  const presentation = JSON.parse(await readFile(path.resolve('plugins/feishu-office/.neuxally/auth/presentation.json'), 'utf8'));
  assert.deepEqual(challenges[0].params.notice, presentation.notices.initialSetup);
  assert.equal(challenges[1].params.notice, undefined);
  assert.ok(challenges[0].params.deadlineAt); assert.equal(challenges[0].params.expiresAt, undefined);
  assert.ok(challenges[1].params.expiresAt);
  assert.equal((await f.request('auth/status')).result.state, 'authorized');
  const resolved = await f.request('auth/resolve', { components: [{ componentId: 'stable-doc', key: 'skills/lark-doc', target: 'skill' }] });
  assert.equal(resolved.result.bindings.length, 1);
  assert.equal(resolved.result.bindings[0].componentId, 'stable-doc');
  assert.equal(resolved.result.bindings[0].environment.LARKSUITE_CLI_CONFIG_DIR, path.join(f.params.dataDirectory, 'profile'));
  assert.equal(resolved.result.bindings[0].environment.LARKSUITE_CLI_ACCESS_TOKEN, '');
  assert.ok((await f.request('auth/resolve', { components: [{ componentId: 'bad', key: 'github', target: 'mcp', url: 'https://evil.example' }] })).error);
  assert.ok((await f.request('auth/status', { sessionId: 'other' })).error);
  const publicMessages = f.messages.filter(x => x.method || x.id !== resolved.id);
  assert.doesNotMatch(JSON.stringify(publicMessages), /PRIVATE-DEVICE-TOKEN|INHERITED-SECRET/);
  assert.equal(f.stderr(), '');
  assert.equal((await f.request('auth/logout')).result.state, 'unauthorized');
  assert.equal((await f.request('auth/status')).result.account.available, false);
});

for (const scenario of ['unverified', 'missing-scope']) {
  test(`CLI 退出成功但 ${scenario} 时不能标记已授权`, async t => {
    const f = await bridge(t, scenario); await f.request('auth/start'); await f.waitState('failed');
    assert.equal((await f.request('auth/status')).result.account.available, false);
    const resolved = await f.request('auth/resolve', { components: [{ componentId: 'doc', key: 'skills/lark-doc', target: 'skill' }] });
    assert.equal(resolved.result.bindings[0].environment.LARKSUITE_CLI_CONFIG_DIR, path.join(f.params.dataDirectory, 'profile'));
  });
}

test('取消必须等待上游进程停止；旧会话不能继续交付凭据', async t => {
  const f = await bridge(t, 'cancel'); await f.request('auth/start');
  for(let i=0;i<100 && f.messages.filter(x=>x.method==='auth/challenge').length<2;i++)await new Promise(resolve=>setTimeout(resolve,20));
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal((await f.request('auth/cancel')).result.state, 'cancelled');
  assert.equal(await readFile(path.join(f.params.dataDirectory, 'profile/stopped'), 'utf8'), 'yes');
  await f.waitState('cancelled');
  const before = f.messages.filter(x => x.method === 'auth/challenge').length;
  assert.ok(f.messages.find(x => x.method === 'auth/challenge').params.notice);
  assert.equal(f.messages.filter(x => x.method === 'auth/challenge').at(-1).params.notice, undefined);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(f.messages.filter(x => x.method === 'auth/challenge').length, before);
  assert.ok(f.messages.filter(x => x.method === 'auth/state' && x.params.state === 'cancelled').every(x => x.params.notice === undefined));
  const resolved = await f.request('auth/resolve', { components: [{ componentId: 'doc', key: 'skills/lark-doc', target: 'skill' }] });
  assert.equal(resolved.result.bindings[0].environment.LARKSUITE_CLI_CONFIG_DIR, path.join(f.params.dataDirectory, 'profile'));
});


test('官方期限到期会停止上游等待，并在刷新时生成新挑战', async t => {
  const f = await bridge(t, 'expired'); await f.request('auth/start'); await f.waitState('expired');
  const previous = f.messages.filter(x => x.method === 'auth/challenge').at(-1).params.challengeId;
  const resolved = await f.request('auth/resolve', { components: [{ componentId: 'doc', key: 'skills/lark-doc', target: 'skill' }] });
  assert.equal(resolved.result.bindings[0].environment.LARKSUITE_CLI_CONFIG_DIR, path.join(f.params.dataDirectory, 'profile'));
  await f.request('auth/start');
  for(let i=0;i<100 && f.messages.filter(x=>x.method==='auth/challenge').at(-1).params.challengeId===previous;i++)await new Promise(resolve=>setTimeout(resolve,20));
  assert.notEqual(f.messages.filter(x=>x.method==='auth/challenge').at(-1).params.challengeId, previous);
  await f.request('auth/cancel');
});


for (const options of [{ downloaded: true }, { overrideName: 'trusted-lark-asset-with-digest' }]) {
  test(`${options.downloaded ? '真实下载' : '任意名称受信覆盖'}经 resolve 后可按官方命令名执行，不能回退用户全局 CLI`, async t => {
    const f = await bridge(t, 'success', options); await f.request('auth/start'); await f.waitState('authorized');
    const resolved = await f.request('auth/resolve', { components: [{ componentId: 'doc', key: 'skills/lark-doc', target: 'skill' }] });
    assert.equal(resolved.error, undefined);
    const result = spawnSync('lark-cli', ['probe'], { env: { ...process.env, ...resolved.result.bindings[0].environment }, encoding: 'utf8' });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), `MANAGED:${path.join(f.params.dataDirectory, 'profile')}`);
    await assert.rejects(readFile(f.foreignMarker), { code: 'ENOENT' });
  });
}


test('创建应用完成但用户身份尚未出现时仍能查询状态并继续用户扫码', async t => {
  const f = await bridge(t, 'app-only');
  const before = await f.request('auth/status');
  assert.equal(before.error, undefined);
  assert.equal(before.result.account.configured, true);
  assert.equal(before.result.account.available, false);
  assert.equal((await f.request('auth/start')).result.state, 'pending');
  await f.waitState('authorized');
  const challenges = f.messages.filter(x => x.method === 'auth/challenge');
  assert.equal(challenges.length, 1);
  assert.match(challenges[0].params.actions[0].url, /auth\/device/);
  assert.equal(challenges[0].params.notice, undefined);
  assert.equal((await f.request('auth/status')).result.account.available, true);
});


test('新建应用后保持待用户授权，第二次扫码完成并真实核验才ready', async t => {
  const f = await bridge(t, 'two-stage-app-only'); await f.request('auth/start');
  for (let i = 0; i < 100 && f.messages.filter(x => x.method === 'auth/challenge').length < 2; i++) await new Promise(resolve => setTimeout(resolve, 20));
  const challenges = f.messages.filter(x => x.method === 'auth/challenge');
  assert.equal(challenges.length, 2); assert.notEqual(challenges[0].params.challengeId, challenges[1].params.challengeId);
  assert.ok(challenges[0].params.notice); assert.equal(challenges[1].params.notice, undefined);
  const middle = await f.request('auth/status');
  assert.equal(middle.error, undefined); assert.equal(middle.result.state, 'pending');
  assert.equal(middle.result.account.configured, true); assert.equal(middle.result.account.available, false);
  assert.equal(f.messages.some(x => x.method === 'auth/state' && x.params.state === 'authorized'), false);
  await writeFile(path.join(f.params.dataDirectory, 'profile/complete-user'), 'yes');
  await f.waitState('authorized'); assert.equal((await f.request('auth/status')).result.account.available, true);
});


test('首次应用设置挑战取消后停止真实进程，不产生下一阶段或遗留提示', async t => {
  const f=await bridge(t,'cancel-initial');await f.request('auth/start');
  for(let i=0;i<100&&!f.messages.some(x=>x.method==='auth/challenge');i++)await new Promise(resolve=>setTimeout(resolve,20));
  const first=f.messages.find(x=>x.method==='auth/challenge');assert.ok(first.params.notice);
  assert.equal((await f.request('auth/cancel')).result.state,'cancelled');await f.waitState('cancelled');
  assert.equal(await readFile(path.join(f.params.dataDirectory,'profile/stopped-initial'),'utf8'),'yes');
  await new Promise(resolve=>setTimeout(resolve,50));assert.equal(f.messages.filter(x=>x.method==='auth/challenge').length,1);
  assert.ok(f.messages.filter(x=>x.method==='auth/state').every(x=>x.params.notice===undefined));
});

test('桥接挑战提示取自包内声明，第二阶段不复用第一次提示', async t => {
  const messages={en:'Package-declared first step warning.','zh-CN':'包内声明的首次步骤提示。'};
  const f=await bridge(t,'success',{presentation:{schemaVersion:1,notices:{initialSetup:{messages}}}});
  await f.request('auth/start');await f.waitState('authorized');
  const challenges=f.messages.filter(x=>x.method==='auth/challenge');assert.deepEqual(challenges[0].params.notice,{messages});assert.equal(challenges[1].params.notice,undefined);
});


test('冷启动 resolve 只加载本地隔离环境，不执行在线身份预检', async t => {
  const f = await bridge(t, 'offline-resolve');
  const resolved = await f.request('auth/resolve', { components: [{ componentId: 'doc', key: 'skills/lark-doc', target: 'skill' }] });
  assert.equal(resolved.error, undefined);
  assert.equal(resolved.result.bindings[0].environment.LARKSUITE_CLI_CONFIG_DIR, path.join(f.params.dataDirectory, 'profile'));
  await assert.rejects(readFile(path.join(f.params.dataDirectory, 'profile/unexpected-status')), { code: 'ENOENT' });
  assert.ok((await f.request('auth/status')).error, 'explicit status must still run vendor validation');
});

test('受管 CLI 未缓存时 resolve 仍交付 Skill 环境，实际调用才报告依赖缺失', async t => {
  const f = await bridge(t, 'offline-resolve', { downloaded: true });
  const resolved = await f.request('auth/resolve', { components: [{ componentId: 'doc', key: 'skills/lark-doc', target: 'skill' }] });
  assert.equal(resolved.error, undefined);
  const environment = { ...process.env, ...resolved.result.bindings[0].environment };
  assert.equal(environment.LARKSUITE_CLI_CONFIG_DIR, path.join(f.params.dataDirectory, 'profile'));
  const result = process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/c', 'lark-cli probe'], { env: environment, encoding: 'utf8' })
    : spawnSync('sh', ['-c', 'lark-cli probe'], { env: environment, encoding: 'utf8' });
  assert.equal(result.status, 127);
  assert.match(result.stderr, /plugin_dependency_unavailable/);
  await assert.rejects(readFile(f.foreignMarker), { code: 'ENOENT' });
});
