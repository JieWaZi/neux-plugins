import { loadChallengePresentation } from './presentation.mjs';
import { ensureAsset, ensureTrustedAsset } from './assets.mjs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, chmod, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const authPresentation = await loadChallengePresentation();
const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const requiredScopes = JSON.parse(await readFile(new URL('../integration.json', import.meta.url), 'utf8')).authentication.scopes;
const trustedBinary = process.env.NEUXALLY_LARK_CLI;
let binary;
const children = new Set(); let identity, task, controller, state = 'unauthorized';
const send = value => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
const failure = code => Object.assign(new Error(code), { code });
const emptyAccount = () => ({ configured: false, available: false, scopes: [] });
const notify = (method, params) => send({ method, params: { sessionId: identity.sessionId, ...params } });

function bind(params) {
  if (!params || !params.sessionId || !params.pluginId || !path.isAbsolute(params.dataDirectory ?? '') || !Array.isArray(params.scopes) || params.scopes.some(scope => !requiredScopes.includes(scope))) throw failure('invalid_session');
  const requested = { sessionId: params.sessionId, pluginId: params.pluginId, dataDirectory: path.resolve(params.dataDirectory), scopes: [...new Set(params.scopes)].sort() };
  if (identity && JSON.stringify(identity) !== JSON.stringify(requested)) throw failure('invalid_session');
  identity ??= requested;
}

// 清空外部覆盖值；所有官方存储通过隔离构建绑定私有 profile，不继承用户 CLI 身份。
function environment() {
  const result = {};
  for (const key of Object.keys(process.env)) if (key.toUpperCase().startsWith('LARKSUITE_CLI_')) result[key] = '';
  result.LARKSUITE_CLI_CONFIG_DIR = path.join(identity.dataDirectory, 'profile');
  result.LARKSUITE_CLI_DATA_DIR = path.join(identity.dataDirectory, 'credentials');
  result.LARKSUITE_CLI_NO_UPDATE_NOTIFIER = '1'; result.LARKSUITE_CLI_NO_SKILLS_NOTIFIER = '1';
  result.PATH = `${path.dirname(binary)}${path.delimiter}${process.env.PATH ?? ''}`;
  return result;
}

async function prepare({ localOnly = false } = {}) {
  binary = await (trustedBinary ? ensureTrustedAsset({ dataDirectory: identity.dataDirectory, binary: trustedBinary }) : ensureAsset({ dataDirectory: identity.dataDirectory, signal: controller?.signal, download: !localOnly })).catch(() => { throw failure('plugin_not_ready'); });
  if (!path.isAbsolute(binary)) throw failure('plugin_not_ready');
  await access(binary);
  for (const directory of [identity.dataDirectory, path.join(identity.dataDirectory, 'profile'), path.join(identity.dataDirectory, 'credentials')]) { await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700); }
}

// 原始 CLI 输出只在本进程解析；错误只返回稳定码，stdout 永远只有协议帧。
function run(args, { signal, timeout = 30000, stderrLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env: { ...process.env, ...environment() }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    children.add(child); let output = '', diagnostic = '', total = 0, reason, killTimer;
    const stop = code => { reason ??= code; child.kill('SIGTERM'); killTimer ??= setTimeout(() => child.kill('SIGKILL'), 1000); };
    const aborted = () => stop('cancelled'); signal?.addEventListener('abort', aborted, { once: true });
    const timer = setTimeout(() => stop('expired'), timeout);
    if (signal?.aborted) aborted();
    child.stdout.on('data', bytes => { total += bytes.length; if (total > 1024 * 1024) stop('output_limit'); else output += bytes; });
    child.stderr.on('data', bytes => {
      total += bytes.length; if (total > 1024 * 1024) { stop('output_limit'); return; }
      if (!stderrLine) return;
      diagnostic += bytes;
      let split; while ((split = diagnostic.indexOf('\n')) >= 0) { stderrLine(diagnostic.slice(0, split).trim()); diagnostic = diagnostic.slice(split + 1); }
    });
    let settled = false;
    const finish = error => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', aborted); children.delete(child); if (error) reject(failure(error)); else resolve(output); };
    child.once('error', () => finish('plugin_not_ready'));
    child.once('close', code => { if (stderrLine && diagnostic) stderrLine(diagnostic.trim()); finish(reason ?? (code === 0 ? undefined : 'authorization_failed')); });
  });
}
const parse = value => { try { return JSON.parse(value); } catch { throw failure('invalid_cli_result'); } };

async function account() {
  try { await access(path.join(identity.dataDirectory, 'profile/config.json')); } catch { return emptyAccount(); }
  await prepare();
  const value = parse(await run(['auth', 'status', '--json', '--verify']));
  if (!value.appId) throw failure('invalid_cli_result');
  // 应用已创建而用户尚未登录是合法中间态，刷新后继续用户授权而不是重建应用。
  const user = value.identities?.user ?? {}; const scopes = typeof user.scope === 'string' ? user.scope.split(/\s+/).filter(Boolean) : [];
  return { configured: true, available: user.available === true && user.verified === true && identity.scopes.every(scope => scopes.includes(scope)), id: user.openId ?? '', name: user.userName ?? '', appId: value.appId, scopes };
}

function challenge(url, timing, notice) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !['open.feishu.cn', 'accounts.feishu.cn'].includes(parsed.hostname) || parsed.port) throw failure('invalid_challenge');
  notify('auth/challenge', { challengeId: randomUUID(), actions: [{ type: 'open-url', url }, { type: 'show-qr', value: url }], ...timing, ...(notice ? { notice } : {}) });
}

async function authorize(signal) {
  try {
    await prepare();
    const existing = await account();
    if (!existing.configured) {
      let found = false;
      await run(['config', 'init', '--new', '--brand', 'feishu', '--lang', 'zh_cn'], { signal, timeout: 600000, stderrLine: line => {
        try { const url = new URL(line); if (!found && url.protocol === 'https:' && url.host === 'open.feishu.cn' && url.pathname === '/page/cli' && url.searchParams.get('user_code') && !url.username && !url.password) { found = true; challenge(line, { deadlineAt: Date.now() + 600000 }, authPresentation.notices.initialSetup); } } catch { /* 仅接受官方独立 URL 行，其他输出不公开。 */ }
      } });
      if (!found) throw failure('invalid_challenge');
    } else if (existing.available) { state = 'authorized'; notify('auth/state', { state, account: existing }); return; }
    if (signal.aborted) throw failure('cancelled');
    const device = parse(await run(['auth', 'login', '--no-wait', '--json', '--scope', identity.scopes.join(' ')], { signal }));
    if (!device.device_code || !Number.isInteger(device.expires_in) || device.expires_in <= 0 || device.expires_in > 1800 || typeof device.verification_url !== 'string') throw failure('invalid_cli_result');
    challenge(device.verification_url, { expiresAt: Date.now() + device.expires_in * 1000 });
    const result = parse(await run(['auth', 'login', '--device-code', device.device_code, '--json'], { signal, timeout: device.expires_in * 1000 }));
    if (result.event !== 'authorization_complete' || (result.missing?.length ?? 0) > 0) throw failure('authorization_failed');
    const verified = await account();
    if (signal.aborted) throw failure('cancelled');
    if (!verified.available) throw failure('authorization_unverified');
    state = 'authorized'; notify('auth/state', { state, account: verified });
  } catch (error) {
    state = signal.aborted ? 'cancelled' : error.code === 'expired' ? 'expired' : 'failed';
    notify('auth/state', { state, errorCode: ['cancelled', 'expired'].includes(state) ? undefined : 'authorization_failed' });
  }
}

async function stop() {
  controller?.abort();
  await task;
}

async function dispatch(method, params) {
  bind(params);
  if (method === 'auth/start') {
    if (task && state === 'pending') return { state };
    state = 'pending'; controller = new AbortController();
    // 响应先于新挑战发出；同一会话的刷新必须等待上次工作完成。
    task = new Promise(resolve => setImmediate(resolve)).then(() => authorize(controller.signal));
    return { state };
  }
  if (method === 'auth/cancel') { await stop(); state = 'cancelled'; notify('auth/state', { state }); return { state }; }
  if (method === 'auth/logout') { await stop(); const current = await account(); if (current.configured) await run(['auth', 'logout']); state = 'unauthorized'; return { state }; }
  if (method === 'auth/status') { const current = await account(); return { state: state === 'pending' ? state : current.available ? 'authorized' : 'unauthorized', account: current }; }
  if (method === 'auth/resolve') {
    // 加载只投射当前插件私有环境；在线身份与范围由显式状态查询和真实业务调用核验。
    await prepare({ localOnly: true });
    if (!Array.isArray(params.components) || !params.components.length) throw failure('invalid_components');
    const seen = new Set(); const bindings = [];
    for (const component of params.components) {
      if (component.target !== 'skill' || !component.componentId || seen.has(component.componentId) || !/^skills\/[a-z0-9-]+$/.test(component.key ?? '') || component.url) throw failure('invalid_components');
      await access(path.join(packageRoot, component.key, 'SKILL.md')); seen.add(component.componentId);
      bindings.push({ componentId: component.componentId, environment: environment() });
    }
    return { bindings };
  }
  throw failure('method_not_found');
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  if (line.length > 1024 * 1024) { send({ id: null, error: { code: -32600, message: 'request_limit' } }); return; }
  let request; try { request = JSON.parse(line); } catch { send({ id: null, error: { code: -32700, message: 'invalid_json' } }); return; }
  if (request.jsonrpc !== '2.0' || request.id == null || typeof request.method !== 'string') { send({ id: request.id ?? null, error: { code: -32600, message: 'invalid_request' } }); return; }
  dispatch(request.method, request.params).then(result => send({ id: request.id, result }), error => send({ id: request.id, error: { code: -32000, message: ['invalid_session', 'plugin_not_ready', 'invalid_components', 'authorization_required', 'method_not_found'].includes(error.code) ? error.code : 'authorization_failed' } }));
});
const shutdown = async () => { await stop(); for (const child of children) child.kill('SIGKILL'); input.close(); process.exit(0); };
input.on('close', shutdown); process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
