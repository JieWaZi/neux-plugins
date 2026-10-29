import { ensureAsset, ensureTrustedAsset } from './assets.mjs';
import { cliRunner } from './process.mjs';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

const declaredScopes = JSON.parse(await readFile(new URL('../integration.json', import.meta.url), 'utf8')).authentication.scopes;
const endpoint = 'https://api.githubcopilot.com/mcp/';
let identity, runner, task, controller, state = 'unauthorized';
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const failure = code => Object.assign(new Error(code), { code });
const emptyAccount = configured => ({ configured, available: false, scopes: [] });
const notify = (method, params) => send({ method, params: { sessionId: identity.sessionId, ...params } });
const profile = () => path.join(identity.dataDirectory, 'profile');

function bind(params) {
  if (!params || typeof params.sessionId !== 'string' || !params.sessionId || typeof params.pluginId !== 'string' || !params.pluginId || !path.isAbsolute(params.dataDirectory ?? '') || !Array.isArray(params.scopes) || params.scopes.some(scope => !declaredScopes.includes(scope))) throw failure('invalid_session');
  const next = { sessionId: params.sessionId, pluginId: params.pluginId, dataDirectory: path.resolve(params.dataDirectory), scopes: [...new Set(params.scopes)].sort() };
  if (identity && JSON.stringify(identity) !== JSON.stringify(next)) throw failure('invalid_session');
  identity ??= next;
}

async function prepare({ localOnly = false, checkVersion = true } = {}) {
  try {
    const lock = JSON.parse(await readFile(new URL('./assets.lock.json', import.meta.url), 'utf8'));
    const binary = process.env.NEUXALLY_GH_CLI ? await ensureTrustedAsset({ dataDirectory: identity.dataDirectory, binary: process.env.NEUXALLY_GH_CLI }) : await ensureAsset({ dataDirectory: identity.dataDirectory, signal: controller?.signal, lock, download: !localOnly });
    for (const directory of [identity.dataDirectory, profile(), path.join(identity.dataDirectory, 'home')]) { await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700); }
    runner = cliRunner(binary, identity.dataDirectory);
    if (checkVersion) {
      const version = await runner.run(['--version'], { signal: controller?.signal });
      if (typeof lock.version !== 'string' || !version.startsWith(`gh version ${lock.version}\n`) && !version.startsWith(`gh version ${lock.version} `)) throw failure('plugin_not_ready');
    }
  } catch (error) { throw failure(error.code === 'cancelled' ? 'cancelled' : 'plugin_not_ready'); }
}

// 官方范围可能归一化为更大的权限；只解释已知 OAuth 蕴含关系。
function granted(scopes, required) {
  const implications = { 'admin:org': ['write:org', 'read:org'], 'write:org': ['read:org'], repo: ['public_repo', 'repo:status', 'repo_deployment', 'repo:invite', 'security_events', 'admin:repo_hook', 'write:repo_hook', 'read:repo_hook'], user: ['read:user', 'user:email', 'user:follow'], project: ['read:project'] };
  return scopes.some(scope => scope === required || implications[scope]?.includes(required));
}

async function account() {
  const filename = path.join(profile(), 'hosts.yml');
  try { if (!(await lstat(filename)).isFile()) throw failure('authorization_failed'); } catch (error) { if (error.code === 'ENOENT') return emptyAccount(false); throw error; }
  await prepare();
  let response;
  try { response = JSON.parse(await runner.run(['auth', 'status', '--hostname', 'github.com', '--active', '--json', 'hosts'])); } catch { throw failure('authorization_failed'); }
  if (!Array.isArray(response.hosts?.['github.com'])) throw failure('authorization_failed');
  const entry = response.hosts['github.com'].find(value => value.active === true);
  if (!entry) return emptyAccount(true);
  if (entry.tokenSource !== filename || typeof entry.login !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(entry.login) || entry.host !== 'github.com' || typeof entry.scopes !== 'string') throw failure('authorization_failed');
  const scopes = entry.scopes.split(/[,\s]+/).filter(Boolean);
  if (scopes.some(scope => !/^[a-z_:-]{1,100}$/.test(scope))) throw failure('authorization_failed');
  // 宿主不解释供应商权限层级；把已在线核验的蕴含权限展开为有效范围。
  for (const required of identity.scopes) if (!scopes.includes(required) && granted(scopes, required)) scopes.push(required);
  return { configured: true, available: entry.state === 'success' && identity.scopes.every(scope => granted(scopes, scope)), id: entry.login, name: entry.login, scopes };
}

async function authorize(signal) {
  try {
    await prepare();
    const current = await account();
    if (current.available) { state = 'authorized'; notify('auth/state', { state, account: current }); return; }
    let code, url, reported = false;
    await runner.run(['auth', 'login', '--hostname', 'github.com', '--web', '--git-protocol', 'https', '--skip-ssh-key', '--clipboard=false', '--insecure-storage', '--scopes', identity.scopes.join(',')], { signal, timeout: 900000, stderrLine: line => {
      const match = /^! First copy your one-time code: ([A-Z0-9]{4}-[A-Z0-9]{4})$/.exec(line);
      if (match) code = match[1];
      const prefix = 'Open this URL to continue in your web browser: ';
      if (line.startsWith(prefix)) { url = line.slice(prefix.length); if (url !== 'https://github.com/login/device') throw failure('invalid_challenge'); }
      if (!reported && code && url) { reported = true; notify('auth/challenge', { challengeId: randomUUID(), actions: [{ type: 'open-url', url }, { type: 'copy-code', value: code }], deadlineAt: Date.now() + 900000 }); }
    } });
    if (!reported) throw failure('invalid_challenge');
    for (const name of ['hosts.yml', 'config.yml']) { try { await chmod(path.join(profile(), name), 0o600); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    const verified = await account();
    if (signal.aborted) throw failure('cancelled');
    if (!verified.available) throw failure('authorization_failed');
    state = 'authorized'; notify('auth/state', { state, account: verified });
  } catch (error) {
    state = signal.aborted ? 'cancelled' : error.code === 'expired' ? 'expired' : 'failed';
    notify('auth/state', { state, errorCode: state === 'failed' ? (error.code === 'plugin_not_ready' ? 'plugin_not_ready' : 'authorization_failed') : undefined });
  }
}

async function stop() { controller?.abort(); await task; }
async function dispatch(method, params) {
  bind(params);
  if (method === 'auth/start') {
    if (task && state === 'pending') return { state };
    state = 'pending'; controller = new AbortController();
    task = new Promise(resolve => setImmediate(resolve)).then(() => authorize(controller.signal));
    return { state };
  }
  if (method === 'auth/cancel') { await stop(); state = 'cancelled'; notify('auth/state', { state }); return { state }; }
  if (method === 'auth/logout') { await stop(); await rm(profile(), { recursive: true, force: true }); state = 'unauthorized'; return { state }; }
  if (method === 'auth/status') { const current = await account(); return { state: state === 'pending' ? state : current.available ? 'authorized' : 'unauthorized', account: current }; }
  if (method === 'auth/resolve') {
    if (!Array.isArray(params.components) || !params.components.length) throw failure('invalid_components');
    const seen = new Set();
    for (const component of params.components) { if (component.target !== 'mcp' || component.key !== 'github' || component.url !== endpoint || !component.componentId || seen.has(component.componentId)) throw failure('invalid_components'); seen.add(component.componentId); }
    let token = '';
    try {
      const directory = await lstat(profile());
      const credential = await lstat(path.join(profile(), 'hosts.yml'));
      if (directory.isDirectory() && credential.isFile()) {
        await prepare({ localOnly: true, checkVersion: false });
        const local = (await runner.run(['auth', 'token', '--hostname', 'github.com'])).trim();
        if (/^gho_[a-zA-Z0-9]{20,256}$/.test(local)) token = local;
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'plugin_not_ready' && error.code !== 'authorization_failed') throw error;
    }
    return { bindings: params.components.map(component => ({ componentId: component.componentId, headers: { Authorization: token ? 'Bearer ' + token : '' } })) };
  }
  throw failure('method_not_found');
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  if (line.length > 1024 * 1024) { send({ id: null, error: { code: -32600, message: 'request_limit' } }); return; }
  let request; try { request = JSON.parse(line); } catch { send({ id: null, error: { code: -32700, message: 'invalid_json' } }); return; }
  if (request?.jsonrpc !== '2.0' || request.id == null || typeof request.method !== 'string') { send({ id: request?.id ?? null, error: { code: -32600, message: 'invalid_request' } }); return; }
  dispatch(request.method, request.params).then(result => send({ id: request.id, result }), error => send({ id: request.id, error: { code: -32000, message: ['invalid_session', 'plugin_not_ready', 'invalid_components', 'authorization_required', 'method_not_found'].includes(error.code) ? error.code : 'authorization_failed' } }));
});
const shutdown = async () => { await stop(); runner?.terminate(); process.exit(0); };
input.on('close', shutdown); process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
