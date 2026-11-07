import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const commandPath = (dataDirectory, digest, platform) => path.join(dataDirectory, 'cache', digest, platform === 'win32' ? 'wecom-cli.exe' : 'wecom-cli');

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
  validateArchiveAsset(asset, platform);
  const destination = commandPath(dataDirectory, asset.binarySHA256, platform);
  if (await cachedCommand(destination, asset.binarySize, asset.binarySHA256)) return destination;
  const response = await fetcher(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000), redirect: 'follow' });
  if (!response.ok || !response.body || (response.url && new URL(response.url).protocol !== 'https:')) throw new Error('asset_download_failed');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > asset.size) { await response.body.cancel().catch(() => {}); throw new Error('asset_size_mismatch'); } chunks.push(chunk); }
  const bytes = Buffer.concat(chunks); if (bytes.length !== asset.size || hash(bytes) !== asset.sha256) throw new Error('asset_digest_mismatch');
  if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== asset.integrity) throw new Error('asset_integrity_mismatch');
  const binary = extractCommand(bytes, asset);
  return publishCommand(dataDirectory, binary, asset.binarySHA256, platform);
}

// 只读取固定 npm 归档内唯一普通程序文件；从不将归档路径写入文件系统。
function validateArchiveAsset(asset, platform) {
  if (asset.format !== 'npm-tgz' || asset.member !== `package/bin/wecom-cli${platform === 'win32' ? '.exe' : ''}` || !/^[a-f0-9]{64}$/.test(asset.binarySHA256 ?? '') || !Number.isSafeInteger(asset.binarySize) || asset.binarySize <= 0 || asset.binarySize > 128 * 1024 * 1024 || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(asset.integrity ?? '')) throw new Error('invalid_archive_asset');
}

export function extractCommand(archive, asset) {
  const tar = gunzipSync(archive, { maxOutputLength: 128 * 1024 * 1024 });
  const field = bytes => bytes.toString('utf8').replace(/\0.*$/s, '');
  let result;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const octal = field(header.subarray(124, 136)).trim();
    const checksum = field(header.subarray(148, 156)).trim();
    if (!/^[0-7]+$/.test(octal) || !/^[0-7]+$/.test(checksum)) throw new Error('invalid_archive');
    const size = parseInt(octal, 8);
    const expected = parseInt(checksum, 8);
    const actual = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (actual !== expected || !Number.isSafeInteger(size) || offset + 512 + size > tar.length) throw new Error('invalid_archive');
    const prefix = field(header.subarray(345, 500));
    const name = `${prefix ? prefix + '/' : ''}${field(header.subarray(0, 100))}`;
    if (name === asset.member) {
      if (result || ![0, 48].includes(header[156]) || size !== asset.binarySize) throw new Error('invalid_archive_member');
      result = tar.subarray(offset + 512, offset + 512 + size);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!result || hash(result) !== asset.binarySHA256) throw new Error('binary_digest_mismatch');
  return result;
}
