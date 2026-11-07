import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

const maxFileBytes = 16 * 1024;
const maxMessageBytes = 2 * 1024;
const invalid = () => { throw new Error('invalid_auth_presentation'); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));

// 仅承接包内本地化提示，不允许文案声明程序入口、远端地址或额外协议字段。
export function parseChallengePresentation(bytes) {
  if (!bytes || bytes.length > maxFileBytes) invalid();
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { invalid(); }
  if (!exact(value, ['schemaVersion', 'notices']) || value.schemaVersion !== 1 || !object(value.notices)) invalid();
  const entries = Object.entries(value.notices);
  if (!entries.length || entries.length > 16) invalid();
  for (const [key, notice] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key) || !exact(notice, ['messages']) || !exact(notice.messages, ['en', 'zh-CN'])) invalid();
    for (const message of Object.values(notice.messages)) if (typeof message !== 'string' || !message.trim() || Buffer.byteLength(message) > maxMessageBytes || /[\x00-\x1f\x7f]/.test(message)) invalid();
  }
  return value;
}

// 不跟随符号链接，并以固定缓冲区读取，文件增长也不能扩大内存或协议负载。
export async function loadChallengePresentation(filename = new URL('./presentation.json', import.meta.url)) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxFileBytes) invalid();
  const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!(await file.stat()).isFile()) invalid();
    const bytes = Buffer.alloc(maxFileBytes + 1); let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    return parseChallengePresentation(bytes.subarray(0, length));
  } finally { await file.close(); }
}
