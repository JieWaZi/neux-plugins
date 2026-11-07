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
  const auth = path.join(directory, 'package/.neuxbot/auth');
  await cp(path.resolve('plugins/github/.neuxbot/auth'), auth, { recursive: true });
  await writeFile(path.join(directory, 'package/plugin.json'), JSON.stringify({ extensions: { 'com.neuxbot': { authentication: { scopes: ['repo', 'read:org', 'gist'] } } } }));
  const binary = path.join(directory, 'trusted-gh-arbitrary-name');
  await writeFile(binary, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2),p=process.env.GH_CONFIG_DIR;
const emit=v=>console.log(JSON.stringify(v));
if(['GH_TOKEN','GITHUB_TOKEN','GH_ENTERPRISE_TOKEN','GITHUB_ENTERPRISE_TOKEN','KEYCHAIN_ACCESS_GROUP','GH_BROWSER','BROWSER'].some(k=>process.env[k]))process.exit(91);
if(!p||!process.env.HOME.startsWith(${JSON.stringify(directory)})||process.env.PATH.includes('foreign-user-bin'))process.exit(92);
fs.mkdirSync(p,{recursive:true});
if(args[0]==='--version')console.log('gh version ${scenario === 'bad-version' ? 'upstream-unisolated' : '2.102.0-neuxally.test'}');
else if(args[1]==='status')emit({hosts:{'github.com':[{state:'${scenario === 'unverified' ? 'error' : 'success'}',active:true,host:'github.com',login:'example-user',tokenSource:${scenario === 'foreign-source' ? "'/global/hosts.yml'" : "path.join(p,'hosts.yml')"},scopes:'${scenario === 'missing-scope' ? 'gist' : scenario === 'broader-scope' ? 'repo, admin:org, gist' : 'repo, read:org, gist'}',token:'RAW-STATUS-SECRET'}]}});
else if(args[1]==='login'){
 if(!args.includes('--web')||!args.includes('--insecure-storage')||!args.includes('--skip-ssh-key')||!args.includes('--clipboard=false'))process.exit(93);
 ${scenario === 'cancel' ? "process.on('SIGTERM',()=>{fs.writeFileSync(path.join(p,'stopped'),'yes');process.exit(0);});" : ""}
 process.stdout.write('RAW-LOGIN-SECRET\\n');process.stderr.write('diagnostic RAW-LOGIN-SECRET\\n! First copy your one-time code: ABCD-');
 process.stderr.write('EFGH\\nOpen this URL to continue in your web browser: ${scenario === 'malicious-url' ? 'https://github.com.evil.example/login/device' : 'https://github.com/login/device'}\\n');
 ${scenario === 'cancel' ? "setInterval(()=>{},1000);" : "setTimeout(()=>{fs.writeFileSync(path.join(p,'hosts.yml'),'oauth_token: private');},80);"}
}else if(args[1]==='token')console.log('${scenario === 'pat' ? 'ghp_' + 'P'.repeat(36) : oauthToken}');
else process.exit(94);
`);
  await chmod(binary, 0o755);
  const content = await readFile(binary);
  await writeFile(path.join(auth, 'assets.lock.json'), JSON.stringify({ schemaVersion: 1, version: '2.102.0-neuxally.test', assets: { [`${process.platform}-${process.arch}`]: { url: 'https://github.com/example/releases/gh', size: content.length, sha256: createHash('sha256').update(content).digest('hex') } } }));
  const nodeArgs = [];
  if (downloaded) { const preload = path.join(directory, 'download.mjs'); await writeFile(preload, `import {readFile} from 'node:fs/promises';globalThis.fetch=async()=>new Response(await readFile(${JSON.stringify(binary)}),{status:${scenario === 'download-failure' ? 404 : 200}});`); nodeArgs.push('--import', preload); }
  const foreign = path.join(directory, 'foreign-user-bin'); await mkdir(foreign);
  await writeFile(path.join(foreign, 'gh'), '#!/bin/sh\nexit 99\n'); await chmod(path.join(foreign, 'gh'), 0o755);
  const child = spawn(process.execPath, [...nodeArgs, path.join(auth, 'authorize.mjs')], { env: { ...process.env, NEUXALLY_GH_CLI: downloaded ? '' : binary, PATH: `${foreign}${path.delimiter}${process.env.PATH ?? ''}`, GH_TOKEN: 'INHERITED-SECRET', GITHUB_TOKEN: 'INHERITED-SECRET', GH_ENTERPRISE_TOKEN: 'INHERITED-SECRET', KEYCHAIN_ACCESS_GROUP: 'external-keychain', GH_BROWSER: 'external-browser', BROWSER: 'external-browser', GH_CONFIG_DIR: '/foreign-profile' }, stdio: ['pipe', 'pipe', 'pipe'] });
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
  const params = { protocol: 'neuxbot-auth/1', operationId: 'operation-example', versionId: 'version-example', digest: 'a'.repeat(64), configurationRevision: 1, accountGeneration: 0, sessionId: 'example-session', pluginId: 'example-plugin', dataDirectory: path.join(directory, 'private'), scopes: ['repo', 'read:org', 'gist'] };
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
  return { request, wait, waitState, params, messages, stderr: () => stderr };
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
  test(`拒绝未经核验或不受管的GitHub身份：${scenario}`, async t => {
    const f = await bridge(t, scenario); await f.request('auth/start'); const failed = await f.waitState('failed');
    assert.equal(failed.params.errorCode, scenario === 'bad-version' ? 'dependency_unavailable' : 'authorization_failed');
    assert.ok((await f.request('auth/resolve', { components: [{ componentId: 'approved', key: 'github', target: 'mcp', url: endpoint }] })).error);
    assert.doesNotMatch(JSON.stringify(f.messages), /gho_|INHERITED-SECRET|RAW-(?:STATUS|LOGIN)-SECRET/);
  });
}

test('GitHub OAuth范围接受官方已蕴含的组织读权限', async t => {
  const f = await bridge(t, 'broader-scope'); await f.request('auth/start'); await f.waitState('authorized');
  const account = (await f.request('auth/status')).result.account;
  assert.equal(account.available, true);
  assert.ok(account.scopes.includes('read:org'), 'generic host must see the effective granted scope');
});

test('取消等待真实停止CLI并使旧会话无法resolve，刷新产生新挑战', async t => {
  const f = await bridge(t, 'cancel'); await f.request('auth/start');
  await f.wait(x => x.method === 'auth/challenge');
  const old = f.messages.find(x => x.method === 'auth/challenge').params.challengeId;
  assert.equal((await f.request('auth/cancel')).result.state, 'cancelled');
  assert.equal(await readFile(path.join(f.params.dataDirectory, 'profile/stopped'), 'utf8'), 'yes');
  assert.ok((await f.request('auth/resolve', { components: [{ componentId: 'approved', key: 'github', target: 'mcp', url: endpoint }] })).error);
  await f.request('auth/start');
  await f.wait(x => x.method === 'auth/challenge' && x.params.challengeId !== old);
  assert.notEqual(f.messages.filter(x => x.method === 'auth/challenge').at(-1).params.challengeId, old);
  await f.request('auth/cancel');
});

test('私有resolve不把PAT配置冒充设备流OAuth令牌', async t => {
  const f = await bridge(t, 'pat'); await f.request('auth/start'); await f.waitState('authorized');
  assert.ok((await f.request('auth/resolve', { components: [{ componentId: 'approved', key: 'github', target: 'mcp', url: endpoint }] })).error);
  assert.doesNotMatch(JSON.stringify(f.messages), /ghp_/);
});


test('GitHub供应商依赖下载失败不会报告账号授权失效', async t => {
  const f = await bridge(t, 'download-failure', true);
  assert.equal((await f.request('auth/start')).result.state, 'pending');
  const failed = await f.waitState('failed');
  assert.equal(failed.params.errorCode, 'dependency_unavailable');
  assert.equal(f.messages.some(message => message.method === 'auth/challenge'), false);
  assert.equal((await f.request('auth/status')).result.account.available, false);
  assert.doesNotMatch(JSON.stringify(f.messages), /INHERITED-SECRET|RAW-(?:STATUS|LOGIN)-SECRET/);
});
