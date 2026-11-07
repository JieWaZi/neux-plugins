import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureAsset, extractCommand } from '../../plugins/wecom-office/.neuxbot/auth/assets.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function tarMember(name, bytes, type = 48) {
  const header = Buffer.alloc(512);
  header.write(name); header.write('0000755\0', 100); header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124);
  header.fill(32, 148, 156); header[156] = type;
  const checksum = header.reduce((sum, value) => sum + value, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
  return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
}
function fixture(platform = 'linux') {
  const bytes = Buffer.from('#!/bin/sh\nprintf managed-wecom\n');
  const member = `package/bin/wecom-cli${platform === 'win32' ? '.exe' : ''}`;
  const archive = gzipSync(Buffer.concat([tarMember(member, bytes), Buffer.alloc(1024)]));
  const asset = { url: 'https://registry.npmjs.org/@wecom/example/-/example-1.3.4.tgz', format: 'npm-tgz', member, sha256: hash(archive), size: archive.length, binarySHA256: hash(bytes), binarySize: bytes.length, integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}` };
  return { bytes, member, archive, asset };
}

for (const platform of ['linux', 'win32']) {
  test(`官方归档按固定摘要发布 ${platform} 命令；篡改缓存重新核验`, async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'wecom-assets-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const f = fixture(platform); let downloads = 0;
    const options = { dataDirectory: directory, platform, arch: 'x64', lock: { schemaVersion: 1, assets: { [`${platform}-x64`]: f.asset } }, fetcher: async () => { downloads++; return new Response(f.archive); } };
    const command = await ensureAsset(options);
    assert.equal(path.basename(command), platform === 'win32' ? 'wecom-cli.exe' : 'wecom-cli');
    assert.deepEqual(await readFile(command), f.bytes);
    assert.equal(await ensureAsset(options), command); assert.equal(downloads, 1);
    await writeFile(command, 'tampered');
    await ensureAsset(options); assert.equal(downloads, 2); assert.deepEqual(await readFile(command), f.bytes);
  });
}

test('拒绝归档/程序摘要漂移及 npm integrity 不符', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wecom-assets-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const field of ['sha256', 'binarySHA256', 'integrity']) {
    const f = fixture(); f.asset[field] = field === 'integrity' ? `sha512-${Buffer.alloc(64).toString('base64')}` : '0'.repeat(64);
    await assert.rejects(ensureAsset({ dataDirectory: path.join(directory, field), platform: 'linux', arch: 'x64', lock: { schemaVersion: 1, assets: { 'linux-x64': f.asset } }, fetcher: async () => new Response(f.archive) }), /digest|integrity/);
  }
});

test('tar 只接受唯一普通程序，不接受符号链接、重复条目、截断或错误校验和', () => {
  const f = fixture();
  for (const content of [
    tarMember(f.member, f.bytes, 50),
    Buffer.concat([tarMember(f.member, f.bytes), tarMember(f.member, f.bytes)]),
    tarMember(f.member, f.bytes).subarray(0, 512 + f.bytes.length - 1),
    Buffer.from(tarMember(f.member, f.bytes).map((byte, index) => index === 2 ? byte ^ 1 : byte)),
    tarMember('../../outside', f.bytes),
  ]) assert.throws(() => extractCommand(gzipSync(content), f.asset), /archive|digest/);
});

test('不支持的平台在下载前准确拒绝', async () => {
  const lock = JSON.parse(await readFile(new URL('../../plugins/wecom-office/.neuxbot/auth/assets.lock.json', import.meta.url)));
  await assert.rejects(ensureAsset({ dataDirectory: '/unused', platform: 'win32', arch: 'arm64', lock, fetcher: () => { throw new Error('must not fetch'); } }), /unsupported_asset/);
});
