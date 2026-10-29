import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, chmod, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';

const endpoint = 'https://api.githubcopilot.com/mcp/';
const oauthToken = 'gho_' + 'A'.repeat(36);

// 只替换供应商程序和下载 HTTP；真实桥接进程拥有协议、身份核验、私密头与取消。
async function bridge(t, scenario = 'success', downloaded = false) {
  const directory = await mkdtemp(path.join(tmpdir(), 'github-bridge-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const auth = path.join(directory, 'package/.neuxally/auth');
  await cp(path.resolve('plugins/github/.neuxally/auth'), auth, { recursive: true });
  await writeFile(path.join(directory, 'package/.neuxally/integration.json'), JSON.stringify({ authentication: { scopes: ['repo', 'read:org', 'gist'] } }));
  const binary = path.join(directory, 'trusted-gh-arbitrary-name');
  await writeFile(binary, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2),p=process.env.GH_CONFIG_DIR;
const emit=v=>console.log(JSON.stringify(v));
if(['GH_TOKEN','GITHUB_TOKEN','GH_ENTERPRISE_TOKEN','GITHUB_ENTERPRISE_TOKEN','KEYCHAIN_ACCESS_GROUP','GH_BROWSER','BROWSER'].some(k=>process.env[k]))process.exit(91);
if(!p||!process.env.HOME.startsWith(${JSON.stringify(directory)})||process.env.PATH.includes('foreign-user-bin'))process.exit(92);
fs.mkdirSync(p,{recursive:true});
if(args[0]==='--version'){fs.writeFileSync(path.join(p,'unexpected-version'),'yes');console.log('gh version ${scenario === 'bad-version' ? 'upstream-unisolated' : '2.102.0-neuxally.test'}');}
else if(args[1]==='status' && ${scenario === 'offline-resolve'}){fs.writeFileSync(path.join(p,'unexpected-status'),'yes');process.exit(74);}
else if(args[1]==='status')emit({hosts:{'github.com':[{state:'${['unverified', 'expired-token'].includes(scenario) ? 'error' : 'success'}',active:true,host:'github.com',login:'example-user',tokenSource:${scenario === 'foreign-source' ? "'/global/hosts.yml'" : "path.join(p,'hosts.yml')"},scopes:'${scenario === 'missing-scope' ? 'gist' : scenario === 'broader-scope' ? 'repo, admin:org, gist' : 'repo, read:org, gist'}',token:'RAW-STATUS-SECRET'}]}});
else if(args[1]==='login'){
 if(!args.includes('--web')||!args.includes('--insecure-storage')||!args.includes('--skip-ssh-key')||!args.includes('--clipboard=false'))process.exit(93);
 process.stdout.write('RAW-LOGIN-SECRET\\n');process.stderr.write('diagnostic RAW-LOGIN-SECRET\\n! First copy your one-time code: ABCD-');
 process.stderr.write('EFGH\\nOpen this URL to continue in your web browser: ${scenario === 'malicious-url' ? 'https://github.com.evil.example/login/device' : 'https://github.com/login/device'}\\n');
 ${scenario === 'cancel' ? "setInterval(()=>{},1000);process.on('SIGTERM',()=>{fs.writeFileSync(path.join(p,'stopped'),'yes');process.exit(0);});" : "setTimeout(()=>{fs.writeFileSync(path.join(p,'hosts.yml'),'oauth_token: private');},80);"}
}else if(args[1]==='token')${scenario === 'missing-token' ? 'process.exit(1);' : `console.log('${scenario === 'pat' ? 'ghp_' + 'P'.repeat(36) : oauthToken}');`}
else process.exit(94);
`);
  await chmod(binary, 0o755);
  const content = await readFile(binary);
  await writeFile(path.join(auth, 'assets.lock.json'), JSON.stringify({ schemaVersion: 1, version: '2.102.0-neuxally.test', assets: { [`${process.platform}-${process.arch}`]: { url: 'https://github.com/example/releases/gh', size: content.length, sha256: createHash('sha256').update(content).digest('hex') } } }));
  const nodeArgs = [];
  if (downloaded) { const preload = path.join(directory, 'download.mjs'); await writeFile(preload, `import {readFile,writeFile} from 'node:fs/promises';globalThis.fetch=async()=>{await writeFile(${JSON.stringify(path.join(directory, 'unexpected-download'))},'yes');return new Response(await readFile(${JSON.stringify(binary)}));};`); nodeArgs.push('--import', preload); }
  const foreign = path.join(directory, 'foreign-user-bin'); await mkdir(foreign);
  await writeFile(path.join(foreign, 'gh'), '#!/bin/sh\nexit 99\n'); await chmod(path.join(foreign, 'gh'), 0o755);
  if (['offline-resolve', 'expired-token'].includes(scenario)) { await mkdir(path.join(directory, 'private/profile'), { recursive: true }); await writeFile(path.join(directory, 'private/profile/hosts.yml'), 'oauth_token: local-private'); }
  const child = spawn(process.execPath, [...nodeArgs, path.join(auth, 'authorize.mjs')], { env: { ...process.env, NEUXALLY_GH_CLI: downloaded ? '' : binary, PATH: `${foreign}${path.delimiter}${process.env.PATH ?? ''}`, GH_TOKEN: 'INHERITED-SECRET', GITHUB_TOKEN: 'INHERITED-SECRET', GH_ENTERPRISE_TOKEN: 'INHERITED-SECRET', KEYCHAIN_ACCESS_GROUP: 'external-keychain', GH_BROWSER: 'external-browser', BROWSER: 'external-browser', GH_CONFIG_DIR: '/foreign-profile' }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const messages = [], pending = new Map(); let next = 1, stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes; });
  createInterface({ input: child.stdout }).on('line', line => { const value = JSON.parse(line); messages.push(value); if (value.id != null) { pending.get(value.id)?.(value); pending.delete(value.id); } });
  const params = { sessionId: 'example-session', pluginId: 'example-plugin', dataDirectory: path.join(directory, 'private'), scopes: ['repo', 'read:org', 'gist'] };
  const request = (method, extra = {}) => new Promise((resolve, reject) => { const id = next++, timer = setTimeout(() => reject(new Error(`timeout ${method}: ${stderr}`)), 4000); pending.set(id, value => { clearTimeout(timer); resolve(value); }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, ...extra } }) + '\n'); });
  const waitState = async state => { for (let i = 0; i < 200; i++) { const found = messages.find(value => value.method === 'auth/state' && value.params.state === state); if (found) return found; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error(`no state ${state}: ${JSON.stringify(messages)} ${stderr}`); };
  return { request, waitState, params, messages, stderr: () => stderr };
}

for (const downloaded of [false, true]) {
  test(`${downloaded ? '真实锁定下载' : '受信私有覆盖'}执行官方设备流并仅私密绑定精确MCP的OAuth头`, async t => {
    const f = await bridge(t, 'success', downloaded);
    assert.equal((await f.request('auth/status')).result.account.available, false);
    assert.equal((await f.request('auth/start')).result.state, 'pending');
    const final = await f.waitState('authorized');
    assert.equal(final.params.account.name, 'example-user');
    const challenge = f.messages.find(x => x.method === 'auth/challenge').params;
    assert.deepEqual(challenge.actions, [{ type: 'open-url', url: 'https://github.com/login/device' }, { type: 'copy-code', value: 'ABCD-EFGH' }]);
    assert.ok(challenge.deadlineAt); assert.equal(challenge.expiresAt, undefined);
    assert.equal((await f.request('auth/status')).result.state, 'authorized');
    const resolved = await f.request('auth/resolve', { components: [{ componentId: 'approved', key: 'github', target: 'mcp', url: endpoint }] });
    assert.deepEqual(resolved.result.bindings, [{ componentId: 'approved', headers: { Authorization: 'Bearer ' + oauthToken } }]);
    assert.ok((await f.request('auth/resolve', { components: [{ componentId: 'bad', key: 'github', target: 'mcp', url: endpoint + 'evil' }] })).error);
    assert.ok((await f.request('auth/resolve', { components: [{ componentId: 'bad', key: 'other', target: 'mcp', url: endpoint }] })).error);
    assert.ok((await f.request('auth/status', { sessionId: 'foreign-session' })).error);
    const publicMessages = f.messages.filter(x => x.id !== resolved.id);
    assert.doesNotMatch(JSON.stringify(publicMessages), /gho_|INHERITED-SECRET|RAW-(?:STATUS|LOGIN)-SECRET/);
    assert.equal(f.stderr(), '');
    assert.equal((await f.request('auth/logout')).result.state, 'unauthorized');
    assert.equal((await f.request('auth/status')).result.account.available, false);
  });
}

for (const scenario of ['unverified', 'missing-scope', 'foreign-source', 'malicious-url', 'bad-version']) {
  test(`授权流程拒绝未经核验或不受管的GitHub身份，resolve 仍可投射：${scenario}`, async t => {
    const f = await bridge(t, scenario); await f.request('auth/start'); await f.waitState('failed');
    const resolved = await f.request('auth/resolve', { components: [{ componentId: 'approved', key: 'github', target: 'mcp', url: endpoint }] });
    assert.equal(resolved.error, undefined);
    assert.equal(typeof resolved.result.bindings[0].headers.Authorization, 'string');
    assert.doesNotMatch(JSON.stringify(f.messages.filter(message => message.id !== resolved.id)), /gho_|INHERITED-SECRET|RAW-(?:STATUS|LOGIN)-SECRET/);
  });
}

test('GitHub OAuth范围接受官方已蕴含的组织读权限', async t => {
  const f = await bridge(t, 'broader-scope'); await f.request('auth/start'); await f.waitState('authorized');
  const account = (await f.request('auth/status')).result.account;
  assert.equal(account.available, true);
  assert.ok(account.scopes.includes('read:org'), 'generic host must see the effective granted scope');
});

test('取消等待真实停止CLI，resolve 不阻断配置投射，刷新产生新挑战', async t => {
  const f = await bridge(t, 'cancel'); await f.request('auth/start');
  for (let i = 0; i < 100 && !f.messages.some(x => x.method === 'auth/challenge'); i++) await new Promise(resolve => setTimeout(resolve, 20));
  const old = f.messages.find(x => x.method === 'auth/challenge').params.challengeId;
  assert.equal((await f.request('auth/cancel')).result.state, 'cancelled');
  assert.equal(await readFile(path.join(f.params.dataDirectory, 'profile/stopped'), 'utf8'), 'yes');
  const resolved = await f.request('auth/resolve', { components: [{ componentId: 'approved', key: 'github', target: 'mcp', url: endpoint }] });
  assert.deepEqual(resolved.result.bindings, [{ componentId: 'approved', headers: { Authorization: '' } }]);
  await f.request('auth/start');
  for (let i = 0; i < 100 && f.messages.filter(x => x.method === 'auth/challenge').length < 2; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.notEqual(f.messages.filter(x => x.method === 'auth/challenge').at(-1).params.challengeId, old);
  await f.request('auth/cancel');
});

test('私有resolve不把PAT配置冒充设备流OAuth令牌', async t => {
  const f = await bridge(t, 'pat'); await f.request('auth/start'); await f.waitState('authorized');
  const resolved = await f.request('auth/resolve', { components: [{ componentId: 'approved', key: 'github', target: 'mcp', url: endpoint }] });
  assert.deepEqual(resolved.result.bindings, [{ componentId: 'approved', headers: { Authorization: '' } }]);
  assert.doesNotMatch(JSON.stringify(f.messages), /ghp_/);
});


test('冷启动 resolve 只投射本地OAuth令牌，供应商离线不阻止加载', async t => {
  const f = await bridge(t, 'offline-resolve');
  const resolved = await f.request('auth/resolve', { components: [{ componentId: 'approved', key: 'github', target: 'mcp', url: endpoint }] });
  assert.equal(resolved.error, undefined);
  assert.deepEqual(resolved.result.bindings, [{ componentId: 'approved', headers: { Authorization: 'Bearer ' + oauthToken } }]);
  await assert.rejects(readFile(path.join(f.params.dataDirectory, 'profile/unexpected-status')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(f.params.dataDirectory, 'profile/unexpected-version')), { code: 'ENOENT' });
  assert.ok((await f.request('auth/status')).error, 'explicit status must still run vendor validation');
});

test('无本地授权时 resolve 保留精确 MCP 绑定并交付空请求头', async t => {
  const f = await bridge(t, 'missing-token');
  const resolved = await f.request('auth/resolve', { components: [{ componentId: 'approved', key: 'github', target: 'mcp', url: endpoint }] });
  assert.equal(resolved.error, undefined);
  assert.deepEqual(resolved.result.bindings, [{ componentId: 'approved', headers: { Authorization: '' } }]);
  await assert.rejects(readFile(path.join(f.params.dataDirectory, 'profile/unexpected-version')), { code: 'ENOENT' });
});

test('本地令牌存在但受管 CLI 未缓存时 resolve 不下载资产', async t => {
  const f = await bridge(t, 'offline-resolve', true);
  const resolved = await f.request('auth/resolve', { components: [{ componentId: 'approved', key: 'github', target: 'mcp', url: endpoint }] });
  assert.deepEqual(resolved.result.bindings, [{ componentId: 'approved', headers: { Authorization: '' } }]);
  await assert.rejects(readFile(path.join(f.params.dataDirectory, 'profile/unexpected-version')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(path.dirname(f.params.dataDirectory), 'unexpected-download')), { code: 'ENOENT' });
});

test('旧本地令牌由 resolve 原样交付，显式状态查询仍报告不可用', async t => {
  const f = await bridge(t, 'expired-token');
  const resolved = await f.request('auth/resolve', { components: [{ componentId: 'approved', key: 'github', target: 'mcp', url: endpoint }] });
  assert.deepEqual(resolved.result.bindings, [{ componentId: 'approved', headers: { Authorization: 'Bearer ' + oauthToken } }]);
  assert.equal((await f.request('auth/status')).result.account.available, false);
});
