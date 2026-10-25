import { ensureAsset, ensureTrustedAsset } from './assets.mjs';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const requiredScopes = JSON.parse(await readFile(new URL('../integration.json', import.meta.url), 'utf8')).authentication.scopes;
const trustedBinary = process.env.NEUXALLY_WECOM_CLI;
const children = new Set();
const lifetime = new AbortController();
const blockedStates = new Set(['pending', 'cancelled', 'failed', 'expired']);
const qrTimeout = 300000;
let identity, binary, controller, task, closing = false, state = 'unauthorized';
const failure = code => Object.assign(new Error(code), { code });
const emptyAccount = (configured = false) => ({ configured, available: false, scopes: [] });
const send = value => { if (!closing) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`); };
const notify = (method, params) => send({ method, params: { sessionId: identity.sessionId, ...params } });
const profile = () => path.join(identity.dataDirectory, 'profile');

function bind(params) {
  if (!params || typeof params.sessionId !== 'string' || !params.sessionId || typeof params.pluginId !== 'string' || !params.pluginId || !path.isAbsolute(params.dataDirectory ?? '') || !Array.isArray(params.scopes) || params.scopes.some(scope => !requiredScopes.includes(scope))) throw failure('invalid_session');
  const requested = { sessionId: params.sessionId, pluginId: params.pluginId, dataDirectory: path.resolve(params.dataDirectory), scopes: [...new Set(params.scopes)].sort() };
  if (identity && JSON.stringify(identity) !== JSON.stringify(requested)) throw failure('invalid_session');
  identity ??= requested;
}

// 私有配置与受管命令路径随组件交付；不能继承其他终端的 token、端点、请求头或日志覆盖。
function environment() {
  const result = {};
  for (const key of Object.keys(process.env)) if (key.toUpperCase().startsWith('WECOM_CLI_')) result[key] = '';
  result.WECOM_CLI_CONFIG_DIR = profile();
  result.PATH = `${path.dirname(binary)}${path.delimiter}${process.env.PATH ?? ''}`;
  return result;
}

async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw failure('plugin_not_ready');
  await chmod(directory, 0o700);
}

async function prepare(signal = lifetime.signal) {
  if (signal?.aborted) throw failure('cancelled');
  await privateDirectory(identity.dataDirectory);
  await privateDirectory(profile());
  // 文件密钥优先于 keyring，预置私有随机值避免首次读取回退；官方保存仍可能同步隔离的 keyring 项。
  const key = path.join(profile(), '.encryption_key');
  try { await writeFile(key, randomBytes(32).toString('base64'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const keyInfo = await lstat(key);
  if (!keyInfo.isFile() || keyInfo.isSymbolicLink() || keyInfo.size !== 44) throw failure('plugin_not_ready');
  await chmod(key, 0o600);
  binary = await (trustedBinary ? ensureTrustedAsset({ dataDirectory: identity.dataDirectory, binary: trustedBinary }) : ensureAsset({ dataDirectory: identity.dataDirectory, signal })).catch(() => { throw failure('plugin_not_ready'); });
  if (!path.isAbsolute(binary)) throw failure('plugin_not_ready');
  await access(binary);
  if (signal?.aborted) throw failure('cancelled');
}

// 提示与 JSON 分开解析；任何 CLI 原始输出、密钥、token 都不能透传到桥接日志或公开状态。
function run(args, { signal = lifetime.signal, timeout = 30000, cwd = identity.dataDirectory, onLine } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(failure('cancelled')); return; }
    const child = spawn(binary, args, { cwd, env: { ...process.env, ...environment() }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '', pending = '', total = 0, reason, killTimer, lines = Promise.resolve();
    const decoder = new StringDecoder('utf8');
    const stop = code => { reason ??= code; child.kill('SIGTERM'); killTimer ??= setTimeout(() => child.kill('SIGKILL'), 1000); };
    const entry = { stop, done: undefined }; children.add(entry);
    const aborted = () => stop('cancelled'); signal?.addEventListener('abort', aborted, { once: true });
    const timer = setTimeout(() => stop('expired'), timeout);
    const line = value => { if (onLine) lines = lines.then(() => onLine(value.trim())).catch(() => stop('invalid_challenge')); };
    child.stdout.on('data', bytes => {
      total += bytes.length;
      if (total > 1024 * 1024) { stop('output_limit'); return; }
      const value = decoder.write(bytes); output += value; pending += value;
      let split; while ((split = pending.indexOf('\n')) >= 0) { line(pending.slice(0, split)); pending = pending.slice(split + 1); }
    });
    child.stderr.on('data', bytes => { total += bytes.length; if (total > 1024 * 1024) stop('output_limit'); });
    let spawnFailed = false;
    child.once('error', () => { spawnFailed = true; });
    entry.done = new Promise(done => child.once('close', async code => {
      output += decoder.end(); if (pending) line(pending);
      await lines;
      clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', aborted); children.delete(entry);
      const error = reason ?? (spawnFailed ? 'plugin_not_ready' : code === 0 ? undefined : 'authorization_failed');
      if (error) reject(failure(error)); else resolve(output);
      done();
    }));
  });
}

async function account(signal = lifetime.signal) {
  try { const info = await lstat(path.join(profile(), 'credentials.enc')); if (!info.isFile() || info.isSymbolicLink()) throw failure('invalid_cli_result'); }
  catch (error) { if (error.code === 'ENOENT') return emptyAccount(); throw error; }
  await prepare(signal);
  const status = (await run(['auth', 'show', '--status'], { signal })).trim();
  if (status === 'unauthorized') return emptyAccount(true);
  if (status !== 'authorized') throw failure('invalid_cli_result');
  // 官方 auth show 从同源本地凭据输出 Bot ID；不猜测动态 whoami schema，也不解密或复制 token。
  const summary = (await run(['auth', 'show'], { signal })).trim().split(/\r?\n/);
  const ids = summary.filter(line => line.startsWith('Bot ID: '));
  if (!summary.includes('Status: authorized') || ids.length !== 1) throw failure('invalid_cli_result');
  const id = ids[0].slice('Bot ID: '.length);
  if (!id || id.length > 256 || /[\s\x00-\x1f\x7f]/.test(id)) throw failure('invalid_cli_result');
  let verified;
  try { verified = JSON.parse(await run(['identity', 'whoami'], { signal })); }
  catch { throw failure(signal?.aborted ? 'cancelled' : 'authorization_unverified'); }
  if (!verified || Array.isArray(verified) || typeof verified !== 'object' || !Object.keys(verified).length || verified.error || (verified.errcode !== undefined && verified.errcode !== 0)) throw failure('authorization_unverified');
  return { configured: true, available: true, id, name: '企业微信机器人', scopes: [] };
}

function pageURL(line) {
  try {
    const url = new URL(line);
    if (url.protocol === 'https:' && url.hostname === 'work.weixin.qq.com' && !url.port && !url.username && !url.password && url.pathname === '/ai/qc/gen' && url.searchParams.get('source') === 'wecom_cli_external' && url.searchParams.get('scode')) return url.href;
  } catch { /* 非独立官方 URL 行是终端表现，不向宿主传递。 */ }
}

async function qrImage(filename) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 45 || info.size > 128 * 1024) throw failure('invalid_challenge');
  const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await file.stat();
    if (opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) throw failure('invalid_challenge');
    const bytes = Buffer.alloc(info.size + 1); const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const png = bytes.subarray(0, bytesRead);
    if (bytesRead !== info.size || !png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || png.readUInt32BE(8) !== 13 || png.toString('ascii', 12, 16) !== 'IHDR' || png.readUInt32BE(16) < 1 || png.readUInt32BE(16) > 1024 || png.readUInt32BE(20) < 1 || png.readUInt32BE(20) > 1024 || !png.subarray(-12).equals(Buffer.from('0000000049454e44ae426082', 'hex'))) throw failure('invalid_challenge');
    return `data:image/png;base64,${png.toString('base64')}`;
  } finally { await file.close(); }
}

async function authorize(signal) {
  let temporary;
  try {
    await prepare(signal);
    temporary = await mkdtemp(path.join(tmpdir(), 'neuxbot-wecom-qr-'));
    await chmod(temporary, 0o700);
    const filename = path.join(temporary, 'qrcode.png');
    let url, shown = false;
    // 每次 start 都真正重新扫描；旧凭据存在不等于本次会话完成。官方 CLI 独占创建 PNG。
    const deadlineAt = Date.now() + qrTimeout;
    await run(['auth', 'init', '--noninteractive', '--no-browser', '--output-qrcode', filename], {
      signal, timeout: qrTimeout, cwd: temporary,
      onLine: async line => {
        if (signal.aborted || shown) return;
        url ??= pageURL(line);
        if (!line.startsWith('二维码已保存到: ')) return;
        // 输出路径只是完成提示；始终读取预先分配的文件，不跟随输出中的路径或平台规范化差异。
        if (!url) throw failure('invalid_challenge');
        const image = await qrImage(filename);
        if (signal.aborted) return;
        shown = true;
        notify('auth/challenge', { challengeId: randomUUID(), actions: [{ type: 'open-url', url }, { type: 'show-qr', value: image }], deadlineAt });
      },
    });
    if (signal.aborted) throw failure('cancelled');
    if (!shown) throw failure('invalid_challenge');
    await rm(temporary, { recursive: true, force: true }); temporary = undefined;
    const current = await account(signal);
    if (signal.aborted) throw failure('cancelled');
    if (!current.available) throw failure('authorization_unverified');
    state = 'authorized'; notify('auth/state', { state, account: current });
  } catch (error) {
    state = signal.aborted ? 'cancelled' : error.code === 'expired' ? 'expired' : 'failed';
    notify('auth/state', { state, errorCode: ['cancelled', 'expired'].includes(state) ? undefined : 'authorization_failed' });
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => {
      state = 'failed'; notify('auth/state', { state, errorCode: 'authorization_failed' });
    });
  }
}

async function stop() {
  controller?.abort();
  for (const child of children) child.stop('cancelled');
  await Promise.all([...children].map(child => child.done));
  await task;
}

async function dispatch(method, params) {
  bind(params);
  if (method === 'auth/start') {
    if (state === 'pending') return { state };
    await task;
    state = 'pending'; controller = new AbortController();
    task = new Promise(resolve => setImmediate(resolve)).then(() => authorize(controller.signal));
    return { state };
  }
  if (method === 'auth/cancel') { await stop(); state = 'cancelled'; notify('auth/state', { state }); return { state }; }
  if (method === 'auth/logout') {
    await stop();
    // 官方没有 logout 子命令；仅清理本插件的本地 profile，不声称撤销企业微信侧授权。
    await rm(profile(), { recursive: true, force: true }); state = 'unauthorized'; return { state };
  }
  if (method === 'auth/status') {
    if (blockedStates.has(state)) return { state, account: emptyAccount() };
    const current = await account(); return { state: current.available ? 'authorized' : 'unauthorized', account: current };
  }
  if (method === 'auth/resolve') {
    if (blockedStates.has(state)) throw failure('authorization_required');
    const current = await account(); if (!current.available) throw failure('authorization_required');
    if (!Array.isArray(params.components) || !params.components.length) throw failure('invalid_components');
    const seen = new Set(), bindings = [];
    const root = await realpath(packageRoot);
    for (const component of params.components) {
      if (component.target !== 'skill' || typeof component.componentId !== 'string' || !component.componentId || seen.has(component.componentId) || !/^skills\/wecomcli-[a-z0-9-]+$/.test(component.key ?? '') || component.url) throw failure('invalid_components');
      const target = path.join(packageRoot, component.key);
      const actual = await realpath(target).catch(() => { throw failure('invalid_components'); });
      if (actual !== path.join(root, component.key)) throw failure('invalid_components');
      const skill = await lstat(path.join(target, 'SKILL.md')).catch(() => { throw failure('invalid_components'); });
      if (!skill.isFile() || skill.isSymbolicLink()) throw failure('invalid_components');
      seen.add(component.componentId); bindings.push({ componentId: component.componentId, environment: environment() });
    }
    return { bindings };
  }
  throw failure('method_not_found');
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let requests = Promise.resolve();
input.on('line', line => {
  if (closing) return;
  if (line.length > 1024 * 1024) { send({ id: null, error: { code: -32600, message: 'request_limit' } }); return; }
  let request; try { request = JSON.parse(line); } catch { send({ id: null, error: { code: -32700, message: 'invalid_json' } }); return; }
  if (request?.jsonrpc !== '2.0' || request.id == null || typeof request.method !== 'string') { send({ id: request?.id ?? null, error: { code: -32600, message: 'invalid_request' } }); return; }
  requests = requests.then(async () => {
    if (closing) return;
    try { send({ id: request.id, result: await dispatch(request.method, request.params) }); }
    catch (error) { send({ id: request.id, error: { code: -32000, message: ['invalid_session', 'plugin_not_ready', 'invalid_components', 'authorization_required', 'method_not_found'].includes(error.code) ? error.code : 'authorization_failed' } }); }
  });
});

const shutdown = async () => {
  if (closing) return;
  closing = true; lifetime.abort(); input.close();
  await stop(); await requests;
  process.exit(0);
};
input.on('close', shutdown); process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
