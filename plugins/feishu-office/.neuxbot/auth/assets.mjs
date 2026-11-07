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

// 摘要目录隔离版本，固定官方命令名供完整上游技能通过 PATH 调用；校验后原子发布文件。
async function publishCommand(dataDirectory, bytes, digest, platform) {
  const destination = commandPath(dataDirectory, digest, platform);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(destination), `.download-${randomUUID()}`);
  try { await writeFile(temporary, bytes, { flag: 'wx', mode: 0o755 }); await rename(temporary, destination); } finally { await rm(temporary, { force: true }); }
  return destination;
}

// 受信宿主可提供任意文件名的固定构建；仍固化到同一受管布局，不能让技能回退用户 CLI。
export async function ensureTrustedAsset({ dataDirectory, binary, platform = process.platform }) {
  if (!path.isAbsolute(binary)) throw new Error('invalid_trusted_asset');
  const information = await stat(binary);
  if (!information.isFile() || information.size <= 0 || information.size > 128 * 1024 * 1024) throw new Error('invalid_trusted_asset');
  const bytes = await readFile(binary); const digest = hash(bytes);
  const destination = commandPath(dataDirectory, digest, platform);
  if (await cachedCommand(destination, bytes.length, digest)) return destination;
  return publishCommand(dataDirectory, bytes, digest, platform);
}

// 锁文件属于本插件的固定依赖，下载只接受 HTTPS 与完整摘要，不读取远端 latest。
export async function ensureAsset({ dataDirectory, signal, platform = process.platform, arch = process.arch, lock, fetcher = fetch }) {
  lock ??= JSON.parse(await readFile(new URL('./assets.lock.json', import.meta.url), 'utf8'));
  const asset = lock.schemaVersion === 1 ? lock.assets?.[`${platform}-${arch}`] : undefined;
  if (!asset || !/^[a-f0-9]{64}$/.test(asset.sha256 ?? '') || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 128 * 1024 * 1024) throw new Error('unsupported_asset');
  const url = new URL(asset.url);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('invalid_asset_url');
  await mkdir(path.join(dataDirectory, 'cache'), { recursive: true, mode: 0o700 });
  const destination = commandPath(dataDirectory, asset.sha256, platform);
  if (await cachedCommand(destination, asset.size, asset.sha256)) return destination;
  const response = await fetcher(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000), redirect: 'follow' });
  if (!response.ok || !response.body || (response.url && new URL(response.url).protocol !== 'https:')) throw new Error('asset_download_failed');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > asset.size) { await response.body.cancel().catch(() => {}); throw new Error('asset_size_mismatch'); } chunks.push(chunk); }
  const bytes = Buffer.concat(chunks); if (bytes.length !== asset.size || hash(bytes) !== asset.sha256) throw new Error('asset_digest_mismatch');
  return publishCommand(dataDirectory, bytes, asset.sha256, platform);
}
