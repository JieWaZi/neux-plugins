import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';

// 与 catalog 的有效 PNG 夹具一致，包含可完整解码的像素和正确块 CRC。
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';

// 替代外部 CLI，不创建真实账号或调用网络；认证状态、进程与协议运行真实桥接代码。
async function fixture(t, scenario = 'success') {
  const directory = await mkdtemp(path.join(tmpdir(), 'wecom-bridge-test-'));
  const root = path.join(directory, 'plugin'), auth = path.join(root, '.neuxbot/auth');
  await mkdir(auth, { recursive: true });
  for (const file of ['authorize.mjs', 'assets.mjs', 'wire.mjs', 'launcher.mjs']) await copyFile(path.resolve('plugins/wecom-office/.neuxbot/auth', file), path.join(auth, file));
  await writeFile(path.join(root, 'plugin.json'), JSON.stringify({ extensions: { 'com.neuxbot': { authentication: { scopes: [] } } } }));
  await mkdir(path.join(root, 'skills/wecomcli-doc'), { recursive: true });
  await writeFile(path.join(root, 'skills/wecomcli-doc/SKILL.md'), '# Fixture');
  const dataDirectory = path.join(directory, 'private');
  const binary = path.join(directory, 'trusted-official-build');
  await writeFile(binary, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2),p=process.env.WECOM_CLI_CONFIG_DIR;
const scenario=${JSON.stringify(scenario)};
if(Object.entries(process.env).some(([k,v])=>k.toUpperCase().startsWith('WECOM_CLI_')&&k!=='WECOM_CLI_CONFIG_DIR'&&v))process.exit(19);
const flag=path.join(p,'credentials.enc'),root=path.dirname(p);
if(args[0]==='probe'){console.log('MANAGED:'+p);process.exit(0);}
if(!fs.existsSync(path.join(p,'.encryption_key')))process.exit(18);
fs.appendFileSync(path.join(root,'calls'),args.slice(0,3).join(' ')+'\\n');
if(args[0]==='auth'&&args[1]==='show'){
 if(args.includes('--status'))console.log(fs.existsSync(flag)?'authorized':'unauthorized');
 else{console.log('Status: authorized');if(scenario!=='missing-id')console.log('Bot ID: bot-example');}
}else if(args[0]==='identity'&&args[1]==='whoami'){
 if(scenario==='network-failure')process.exit(7);
 console.log(scenario==='empty-identity'?'{}':scenario==='identity-error'?JSON.stringify({errcode:851003,errmsg:'PRIVATE-TOKEN'}):JSON.stringify({verified_identity:'PRIVATE-IDENTITY',token:'PRIVATE-TOKEN'}));
}else if(args[0]==='auth'&&args[1]==='init'){
 if(!args.includes('--noninteractive')||!args.includes('--no-browser'))process.exit(20);
 const q=args[args.indexOf('--output-qrcode')+1];if(fs.existsSync(q))process.exit(21);
 fs.writeFileSync(path.join(root,'qr-path'),q);
 const countFile=path.join(root,'count');const count=fs.existsSync(countFile)?+fs.readFileSync(countFile):0;fs.writeFileSync(countFile,''+(count+1));
 if(scenario==='cancel'||scenario==='eof'||scenario==='ignore-term'||scenario==='expired'){
  setInterval(()=>{},1000);process.on('SIGTERM',()=>{fs.writeFileSync(path.join(root,'term-received'),'yes');if(scenario!=='ignore-term')setTimeout(()=>{fs.writeFileSync(path.join(root,'stopped'),'yes');process.exit(0)},80)});
 }
 console.log('PRIVATE-TOKEN');console.log('https://work.weixin.qq.com.evil.example/ai/qc/gen?source=wecom_cli_external&scode=bad');
 if(scenario!=='wrong-host')console.log('https://work.weixin.qq.com/ai/qc/gen?source=wecom_cli_external&scode=EXAMPLE-'+count);
 if(scenario!=='missing-png'){
  const image=Buffer.from(${JSON.stringify(png)},'base64');
  if(scenario==='oversized-png')fs.writeFileSync(q,Buffer.alloc(131073));
  else if(scenario==='invalid-png')fs.writeFileSync(q,Buffer.alloc(50));
  else if(scenario==='symlink-png'){const external=path.join(root,'elsewhere.png');fs.writeFileSync(external,image);fs.symlinkSync(external,q);}
  else fs.writeFileSync(q,image,{mode:0o600});
  console.log('二维码已保存到: '+q);
 }
 if(!['cancel','eof','ignore-term','expired','no-credentials'].includes(scenario))fs.writeFileSync(flag,'PRIVATE-CREDENTIALS');
}else process.exit(22);
`);
  await chmod(binary, 0o755);
  const foreign = path.join(directory, 'global'); await mkdir(foreign);
  await writeFile(path.join(foreign, 'wecom-cli'), '#!/usr/bin/env node\nprocess.exit(23)'); await chmod(path.join(foreign, 'wecom-cli'), 0o755);
  const nodeArgs = [];
  const clockControl = path.join(directory, 'expire-clock'); let clockTicks = 0;
  if (scenario === 'expired') {
    await writeFile(clockControl, '');
    const clock = path.join(directory, 'clock.mjs');
    await writeFile(clock, `import{watchFile,readFileSync}from'node:fs';
const schedule=globalThis.setTimeout,cancel=globalThis.clearTimeout,timers=new Map();
globalThis.setTimeout=(fn,ms,...args)=>{const timer=schedule(()=>{timers.delete(timer);fn(...args)},ms);if(ms===300000)timers.set(timer,()=>{cancel(timer);timers.delete(timer);fn(...args)});return timer};
globalThis.clearTimeout=timer=>{timers.delete(timer);cancel(timer)};
let observed='';watchFile(${JSON.stringify(clockControl)},{interval:20},()=>{const serial=readFileSync(${JSON.stringify(clockControl)},'utf8');if(serial===observed)return;observed=serial;for(const expire of [...timers.values()])expire()});
`);
    nodeArgs.push('--import', clock);
  }
  const child = spawn(process.execPath, [...nodeArgs, path.join(auth, 'authorize.mjs')], {
    env: { ...process.env, PATH: `${foreign}${path.delimiter}${process.env.PATH ?? ''}`, NEUXALLY_WECOM_CLI: scenario === 'dependency-unavailable' ? path.join(directory, 'missing-supplier') : binary, WECOM_CLI_ACCESS_TOKEN: 'INHERITED-TOKEN', WECOM_CLI_CONFIG_DIR: '/do-not-touch', WECOM_CLI_ADDITIONAL_HEADERS_TEST: '{"Authorization":"FOREIGN"}', WECOM_CLI_LOG_DIR: '/do-not-touch-log' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = new Promise(resolve => child.once('close', resolve));
  t.after(async () => { child.stdin.end(); child.kill('SIGTERM'); await exited; await rm(directory, { recursive: true, force: true }); });
  const messages = [], pending = new Map(), waiters = new Set(); let next = 1, stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const diagnostic = label => new Error(`${label}: ${JSON.stringify(messages)}; ${stderr}`);
  child.once('close', (code, signal) => {
    for (const entry of pending.values()) entry.reject(diagnostic(`bridge closed (${code ?? signal})`));
    for (const entry of waiters) entry.reject(diagnostic(`bridge closed (${code ?? signal})`));
  });
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line); messages.push(message);
    if (message.id != null) { pending.get(message.id)?.resolve(message); pending.delete(message.id); }
    for (const entry of [...waiters]) if (entry.predicate(message)) entry.resolve(message);
  });
  const params = { protocol: 'neuxbot-auth/1', operationId: 'operation-example', versionId: 'version-example', digest: 'a'.repeat(64), configurationRevision: 1, accountGeneration: 0, sessionId: 'session-example', pluginId: 'plugin-example', dataDirectory, scopes: [] };
  const request = (method, extra = {}) => new Promise((resolve, reject) => {
    const id = next++;
    const timer = setTimeout(() => { pending.delete(id); reject(diagnostic(`timeout ${method}`)); }, 30000);
    pending.set(id, { resolve: message => { clearTimeout(timer); resolve(message); }, reject: error => { clearTimeout(timer); reject(error); } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, ...extra } })}\n`);
  });
  const wait = predicate => new Promise((resolve, reject) => {
    const existing = messages.find(predicate); if (existing) { resolve(existing); return; }
    const finish = (handler, value) => { clearTimeout(timer); waiters.delete(entry); handler(value); };
    const entry = { predicate, resolve: value => finish(resolve, value), reject: error => finish(reject, error) };
    const timer = setTimeout(() => entry.reject(diagnostic('missing protocol event')), 30000);
    waiters.add(entry);
  });
  const waitState = state => wait(message => message.method === 'auth/state' && message.params.state === state);
  const initialized = await request('auth/initialize');
  assert.equal(initialized.result?.protocol, 'neuxbot-auth/1');
  assert.equal(initialized.result?.context.operationId, params.operationId);
  return { directory, root, params, request, wait, waitState, messages, child, exited, expire: () => writeFile(clockControl, String(++clockTicks)), stderr: () => stderr };
}

test('官方 PNG 与页面链接分开交付，在线核验并返回稳定机器人身份', async t => {
  const f = await fixture(t); assert.equal((await f.request('auth/start')).result.state, 'pending');
  const authorized = await f.waitState('authorized');
  assert.deepEqual(authorized.params.account, { configured: true, available: true, id: 'bot-example', name: '企业微信机器人', scopes: [] });
  const challenge = f.messages.find(message => message.method === 'auth/challenge').params;
  assert.equal(challenge.actions[1].type, 'show-qr'); assert.equal(challenge.actions[1].value, `data:image/png;base64,${png}`);
  assert.match(challenge.actions[0].url, /^https:\/\/work\.weixin\.qq\.com\/ai\/qc\/gen\?/);
  assert.ok(challenge.deadlineAt > Date.now()); assert.ok(challenge.deadlineAt <= Date.now() + 300000); assert.equal(challenge.expiresAt, undefined);
  assert.match(await readFile(path.join(f.params.dataDirectory, 'calls'), 'utf8'), /auth show --status\nauth show\nidentity whoami\n/);
  assert.equal((await f.request('auth/status')).result.state, 'authorized');
  const resolved = await f.request('auth/resolve', { components: [{ componentId: 'doc', key: 'skills/wecomcli-doc', target: 'skill' }] });
  assert.equal(resolved.error, undefined);
  const environment = resolved.result.bindings[0].environment;
  assert.equal(environment.WECOM_CLI_ACCESS_TOKEN, undefined); assert.equal(environment.WECOM_CLI_ADDITIONAL_HEADERS_TEST, undefined);
  assert.equal(environment.WECOM_CLI_CONFIG_DIR, path.join(f.params.dataDirectory, 'profile'));
  const probe = spawnSync('wecom-cli', ['probe'], { env: { ...process.env, ...environment, WECOM_CLI_ACCESS_TOKEN: 'FOREIGN-TOKEN', WECOM_CLI_CONFIG_DIR: '/foreign-profile', PATH: `${environment.PATH}${path.delimiter}${process.env.PATH ?? ""}` }, encoding: 'utf8' });
  assert.equal(probe.status, 0); assert.equal(probe.stdout.trim(), `MANAGED:${environment.WECOM_CLI_CONFIG_DIR}`);
  const publicMessages = f.messages.filter(message => message.id !== resolved.id);
  assert.doesNotMatch(JSON.stringify(publicMessages), /PRIVATE-TOKEN|PRIVATE-IDENTITY|PRIVATE-CREDENTIALS|INHERITED-TOKEN/); assert.equal(f.stderr(), '');
  assert.equal((await lstat(path.join(f.params.dataDirectory, 'profile/.encryption_key'))).mode & 0o777, 0o600);
  assert.equal((await f.request('auth/logout')).result.state, 'unauthorized');
  await assert.rejects(lstat(path.join(f.params.dataDirectory, 'profile')), { code: 'ENOENT' });
  assert.equal((await f.request('auth/status')).result.state, 'unauthorized');
  const qr = await readFile(path.join(f.params.dataDirectory, 'qr-path'), 'utf8'); await assert.rejects(lstat(path.dirname(qr)), { code: 'ENOENT' });
});

for (const scenario of ['network-failure', 'empty-identity', 'identity-error', 'missing-id', 'no-credentials', 'missing-png', 'invalid-png', 'oversized-png', 'symlink-png', 'wrong-host']) {
  test(`${scenario} 不得把 CLI 退出成功误判为授权成功`, async t => {
    const f = await fixture(t, scenario); await f.request('auth/start'); const failed = await f.waitState('failed');
    assert.equal(failed.params.errorCode, 'authorization_failed');
    assert.equal(f.messages.some(message => message.method === 'auth/state' && message.params.state === 'authorized'), false);
    assert.equal((await f.request('auth/status')).result.account.available, false);
    assert.ok((await f.request('auth/resolve', { components: [{ componentId: 'doc', key: 'skills/wecomcli-doc', target: 'skill' }] })).error);
    assert.doesNotMatch(JSON.stringify(f.messages), /PRIVATE-TOKEN|INHERITED-TOKEN/);
  });
}

test('已有凭据仍重新扫码；刷新不会把旧账号直接当作新授权', async t => {
  const f = await fixture(t); await f.request('auth/start'); await f.waitState('authorized');
  const before = f.messages.filter(message => message.method === 'auth/challenge').length;
  assert.equal((await f.request('auth/start')).result.state, 'pending');
  await f.wait(message => message.method === 'auth/challenge' && f.messages.filter(item => item.method === 'auth/challenge').length > before);
  assert.equal(await readFile(path.join(f.params.dataDirectory, 'count'), 'utf8'), '2');
  const challenges = f.messages.filter(message => message.method === 'auth/challenge');
  assert.notEqual(challenges[0].params.challengeId, challenges[1].params.challengeId);
  await f.request('auth/cancel');
});

for (const scenario of ['cancel', 'ignore-term']) {
  test(`${scenario} 等待进程实际退出并删除二维码`, async t => {
    const f = await fixture(t, scenario); await f.request('auth/start'); await f.wait(message => message.method === 'auth/challenge');
    assert.equal((await f.request('auth/start')).result.state, 'pending');
    assert.equal(await readFile(path.join(f.params.dataDirectory, 'count'), 'utf8'), '1');
    assert.equal((await f.request('auth/cancel')).result.state, 'cancelled');
    if (scenario === 'cancel') assert.equal(await readFile(path.join(f.params.dataDirectory, 'stopped'), 'utf8'), 'yes');
    assert.equal(await readFile(path.join(f.params.dataDirectory, 'term-received'), 'utf8'), 'yes');
    const qr = await readFile(path.join(f.params.dataDirectory, 'qr-path'), 'utf8'); await assert.rejects(lstat(path.dirname(qr)), { code: 'ENOENT' });
    assert.equal(f.messages.some(message => message.method === 'auth/state' && message.params.state === 'authorized'), false);
  });
}

test('stdin EOF 终止子进程并清理二维码', async t => {
  const f = await fixture(t, 'eof'); await f.request('auth/start'); await f.wait(message => message.method === 'auth/challenge');
  f.child.stdin.end(); await f.exited;
  assert.equal(await readFile(path.join(f.params.dataDirectory, 'stopped'), 'utf8'), 'yes');
  const qr = await readFile(path.join(f.params.dataDirectory, 'qr-path'), 'utf8'); await assert.rejects(lstat(path.dirname(qr)), { code: 'ENOENT' });
});

test('本地五分钟等待上限到期会终止进程并允许重新扫码', async t => {
  const f = await fixture(t, 'expired'); await f.request('auth/start'); await f.wait(message => message.method === 'auth/challenge'); await f.expire(); await f.waitState('expired');
  const first = f.messages.find(message => message.method === 'auth/challenge').params;
  assert.equal(first.expiresAt, undefined);
  assert.equal(await readFile(path.join(f.params.dataDirectory, 'stopped'), 'utf8'), 'yes');
  assert.equal((await f.request('auth/status')).result.state, 'expired');
  await f.request('auth/start');
  await f.wait(message => message.method === 'auth/challenge' && message.params.challengeId !== first.challengeId);
  await f.request('auth/cancel');
});

test('resolve 仅接受真实包内 wecomcli 技能并固定会话', async t => {
  const f = await fixture(t); await f.request('auth/start'); await f.waitState('authorized');
  for (const component of [
    { componentId: 'x', key: 'skills/missing', target: 'skill' },
    { componentId: 'x', key: 'skills/wecomcli-absent', target: 'skill' },
    { componentId: 'x', key: 'skills/../wecomcli-doc', target: 'skill' },
    { componentId: 'x', key: 'skills/wecomcli-doc', target: 'mcp' },
    { componentId: 'x', key: 'skills/wecomcli-doc', target: 'skill', url: 'https://example.com' },
  ]) assert.ok((await f.request('auth/resolve', { components: [component] })).error);
  const outside = path.join(f.directory, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'SKILL.md'), '# Outside');
  await symlink(outside, path.join(f.root, 'skills/wecomcli-link'));
  assert.ok((await f.request('auth/resolve', { components: [{ componentId: 'link', key: 'skills/wecomcli-link', target: 'skill' }] })).error);
  assert.ok((await f.request('auth/status', { sessionId: 'another-session' })).error);
  assert.ok((await f.request('auth/status', { scopes: ['invented-scope'] })).error);
});


test('企业微信缺少供应商程序报告依赖未就绪，不报告账号授权失效', async t => {
  const f = await fixture(t, 'dependency-unavailable');
  assert.equal((await f.request('auth/start')).result.state, 'pending');
  const failed = await f.waitState('failed');
  assert.equal(failed.params.errorCode, 'dependency_unavailable');
  assert.equal(f.messages.some(message => message.method === 'auth/challenge'), false);
  assert.equal((await f.request('auth/status')).result.account.available, false);
  assert.doesNotMatch(JSON.stringify(f.messages), /PRIVATE-TOKEN|INHERITED-TOKEN/);
});
