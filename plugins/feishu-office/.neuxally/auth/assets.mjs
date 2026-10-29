import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const commandPath = (dataDirectory, digest, platform) => path.join(dataDirectory, 'cache', digest, platform === 'win32' ? 'lark-cli.exe' : 'lark-cli');

async function cachedCommand(destination, size, digest) {
  try {
    if (!(await lstat(destination)).isFile()) return false;
    const bytes = await readFile(destination);
    if (bytes.length !== size || hash(bytes) !== digest) return false;
    await chmod(destination, 0o755); return true;
  } catch { return false; }
}

// 私有命令先写临时文件再原子发布，避免并发加载看到尚未写完的入口。
async function publishCommand(destination, bytes) {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(destination), `.download-${randomUUID()}`);
  try { await writeFile(temporary, bytes, { flag: 'wx', mode: 0o755 }); await rename(temporary, destination); } finally { await rm(temporary, { force: true }); }
  return destination;
}

// 聊天加载只确认已发布文件的类型、长度与执行位；完整摘要校验属于依赖准备阶段。
async function preparedCommand(destination, size, platform) {
  try {
    const information = await lstat(destination);
    return information.isFile() && information.size === size && (platform === 'win32' || (information.mode & 0o111) !== 0);
  } catch { return false; }
}

// 缺依赖时仍占据私有 PATH 命令名，真实技能调用再失败，不能命中用户的全局账号与 CLI。
async function unavailableCommand(dataDirectory, platform, arch) {
  const directory = path.join(dataDirectory, 'cache', 'unavailable-v1', `${platform}-${arch}`);
  const diagnostic = 'plugin_dependency_unavailable: managed lark-cli is unavailable; prepare the Feishu Office plugin dependency before using this command.';
  const shell = `#!/bin/sh\nprintf '%s\\n' '${diagnostic}' >&2\nexit 127\n`;
  const command = path.join(directory, 'lark-cli');
  if (!(await preparedCommand(command, Buffer.byteLength(shell), platform))) await publishCommand(command, shell);
  if (platform !== 'win32') return command;
  const batch = `@echo off\r\necho ${diagnostic} 1>&2\r\nexit /b 127\r\n`;
  const windowsCommand = path.join(directory, 'lark-cli.cmd');
  if (!(await preparedCommand(windowsCommand, Buffer.byteLength(batch), platform))) await publishCommand(windowsCommand, batch);
  return windowsCommand;
}

// 受信宿主可提供任意文件名的固定构建；仍固化到同一受管布局，不能让技能回退用户 CLI。
export async function ensureTrustedAsset({ dataDirectory, binary, platform = process.platform }) {
  if (!path.isAbsolute(binary)) throw new Error('invalid_trusted_asset');
  const information = await stat(binary);
  if (!information.isFile() || information.size <= 0 || information.size > 128 * 1024 * 1024) throw new Error('invalid_trusted_asset');
  const bytes = await readFile(binary); const digest = hash(bytes);
  const destination = commandPath(dataDirectory, digest, platform);
  if (await cachedCommand(destination, bytes.length, digest)) return destination;
  return publishCommand(destination, bytes);
}

// 锁文件属于本插件的固定依赖，下载只接受 HTTPS 与完整摘要，不读取远端 latest。
export async function ensureAsset({ dataDirectory, signal, platform = process.platform, arch = process.arch, lock, fetcher = fetch, download = true }) {
  lock ??= JSON.parse(await readFile(new URL('./assets.lock.json', import.meta.url), 'utf8'));
  const asset = lock.schemaVersion === 1 ? lock.assets?.[`${platform}-${arch}`] : undefined;
  if (!asset || !/^[a-f0-9]{64}$/.test(asset.sha256 ?? '') || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 128 * 1024 * 1024) throw new Error('unsupported_asset');
  const url = new URL(asset.url);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('invalid_asset_url');
  await mkdir(path.join(dataDirectory, 'cache'), { recursive: true, mode: 0o700 });
  const destination = commandPath(dataDirectory, asset.sha256, platform);
  if (!download) return await preparedCommand(destination, asset.size, platform) ? destination : unavailableCommand(dataDirectory, platform, arch);
  if (await cachedCommand(destination, asset.size, asset.sha256)) return destination;
  const response = await fetcher(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000), redirect: 'follow' });
  if (!response.ok || !response.body || (response.url && new URL(response.url).protocol !== 'https:')) throw new Error('asset_download_failed');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > asset.size) { await response.body.cancel().catch(() => {}); throw new Error('asset_size_mismatch'); } chunks.push(chunk); }
  const bytes = Buffer.concat(chunks); if (bytes.length !== asset.size || hash(bytes) !== asset.sha256) throw new Error('asset_digest_mismatch');
  return publishCommand(destination, bytes);
}
