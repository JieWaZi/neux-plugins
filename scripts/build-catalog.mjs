import { packageDetails, encodeDetails } from './details.mjs';
import { validateProvenance } from './provenance.mjs';
import { catalogPresentation } from './presentation.mjs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = 'https://github.com/JieWaZi/neux-plugins';
const safePath = value => typeof value === 'string' && value.length > 0 && !value.includes('\\') && !value.includes(':') && value.split('/').every(part => part && part !== '.' && part !== '..' && !part.includes('\0'));

// 构建只读取 Git 对象，工作区改动与文件时间不影响指定提交的产物。
function snapshot(root, sourceCommit) {
  const rows = execFileSync('git', ['-C', root, 'ls-tree', '-rz', '--full-tree', sourceCommit], { maxBuffer: 16 * 1024 * 1024 }).toString().split('\0').filter(Boolean);
  return new Map(rows.map(row => {
    const [, mode, type, oid, name] = /^(\d+) (\w+) ([0-9a-f]+)\t([\s\S]+)$/.exec(row) ?? [];
    if (!safePath(name)) throw new Error(`unsafe snapshot path: ${name}`);
    return [name, { mode, type, oid }];
  }));
}

// ZIP 使用固定时间和 STORE 编码；中央目录保留 Unix 执行位，避免平台压缩器差异。
function zip(files) {
  const local = [], central = []; let offset = 0;
  for (const { name, content, mode } of files) {
    const encoded = Buffer.from(name); let crc = 0xffffffff;
    for (const byte of content) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(33, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(content.length, 18); header.writeUInt32LE(content.length, 22); header.writeUInt16LE(encoded.length, 26);
    local.push(header, encoded, content);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(0x314, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x800, 8); entry.writeUInt16LE(33, 14); entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(content.length, 20); entry.writeUInt32LE(content.length, 24); entry.writeUInt16LE(encoded.length, 28); entry.writeUInt32LE((parseInt(mode, 8) << 16) >>> 0, 38); entry.writeUInt32LE(offset, 42);
    central.push(entry, encoded); offset += header.length + encoded.length + content.length;
  }
  if (files.length > 65535 || offset > 0xffffffff) throw new Error('ZIP64 size limit exceeded');
  const directory = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

export async function buildCatalog({ root, out, sourceCommit, tag = 'v0.1.0' }) {
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('sourceCommit must be a full Git commit');
  if (!/^v\d+\.\d+\.\d+(?:[-.][a-zA-Z0-9.-]+)?$/.test(tag)) throw new Error('release tag must be fixed');
  execFileSync('git', ['-C', root, 'rev-parse', '--verify', `${sourceCommit}^{commit}`], { stdio: 'pipe' });
  const tree = snapshot(root, sourceCommit);
  const read = name => {
    const entry = tree.get(name);
    if (!entry || entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) throw new Error(`invalid file mode or missing manifest: ${name}`);
    if (entry.content) return entry.content;
    entry.content = execFileSync('git', ['-C', root, 'cat-file', 'blob', entry.oid], { maxBuffer: 64 * 1024 * 1024 });
    return entry.content;
  };
  const manifests = [...tree.keys()].filter(name => /^plugins\/[^/]+\/\.codex-plugin\/plugin.json$/.test(name)).sort();
  if (!manifests.length) throw new Error('no canonical plugin manifests');
  const artifacts = [], entries = [];
  for (const filename of manifests) {
    const packagePath = filename.split('/').slice(0, 2).join('/'); const key = packagePath.split('/')[1];
    if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) throw new Error('unsafe plugin key');
    const manifest = JSON.parse(read(filename));
    if (manifest.name !== key || typeof manifest.version !== 'string' || !manifest.version || typeof manifest.description !== 'string') throw new Error(`invalid logical manifest: ${filename}`);
    const presentation = catalogPresentation({ manifest, packagePath, has: name => tree.has(name), read });
    const provenancePath = `${packagePath}/provenance.json`;
    if (!tree.has(provenancePath)) throw new Error(`missing provenance: ${provenancePath}`);
    const provenance = validateProvenance({ data: JSON.parse(read(provenancePath)), packagePath, manifest, read });
    const integrationPath = `${packagePath}/.neuxally/integration.json`;
    if (tree.has(integrationPath) && Object.hasOwn(JSON.parse(read(integrationPath)), 'nativePlugins')) throw new Error('canonical package cannot use native references');
    const selected = [...tree.keys()].filter(name => ['LICENSE', 'THIRD_PARTY_NOTICES.md'].includes(name) || name.startsWith('patches/') || name.startsWith(`${packagePath}/`)).sort();
    const archiveFiles = selected.map(name => ({ name, mode: tree.get(name).mode, content: read(name) }));
    // 每个完整自有标准包附带合法本地索引；宿主适配其他格式，不维护第二份能力定义。
    const codexIndex = { name: `neuxally-${key}`, interface: { displayName: manifest.interface?.displayName || manifest.name }, plugins: [{ name: manifest.name, source: { source: 'local', path: `./${packagePath}` } }] };
    archiveFiles.push({ name: '.agents/plugins/marketplace.json', mode: '100644', content: Buffer.from(`${JSON.stringify(codexIndex, null, 2)}\n`) });
    const archive = zip(archiveFiles.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))));
    const archiveName = `${key}.zip`; artifacts.push([archiveName, archive]);
    const archiveSHA256 = createHash('sha256').update(archive).digest('hex');
    const details = encodeDetails(packageDetails({ sourceCommit, archiveSHA256, packagePath, manifest, presentation, provenance, names: () => [...tree.keys()], has: name => tree.has(name), read }));
    const detailsName = `${key}.details.json`; artifacts.push([detailsName, details]);
    entries.push({ key, sourceCommit, archiveURL: `${repository}/releases/download/${tag}/${archiveName}`, archiveSHA256, packagePath, name: manifest.name, version: manifest.version, description: manifest.description, format: 'codex', ...presentation, detailsURL: `${repository}/releases/download/${tag}/${detailsName}`, detailsSHA256: createHash('sha256').update(details).digest('hex'), detailsSize: details.length });
  }
  const catalog = { schemaVersion: 2, entries };
  // 所有校验和归档完成后才替换输出；失败不留下可被误发布的半包。
  await mkdir(path.dirname(out), { recursive: true });
  const stage = await mkdtemp(`${out}.tmp-`);
  try {
    for (const [name, content] of artifacts) await writeFile(path.join(stage, name), content);
    await writeFile(path.join(stage, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
    try { await cp(path.join(out, 'providers'), path.join(stage, 'providers'), { recursive: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rm(out, { recursive: true, force: true }); await rename(stage, out);
  } finally { await rm(stage, { recursive: true, force: true }); }
  return catalog;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const sourceCommit = execFileSync('git', ['-C', root, 'rev-parse', '--verify', `${process.argv[2] || 'HEAD'}^{commit}`], { encoding: 'utf8' }).trim();
  const tag = process.argv[3] || 'v0.1.0';
  const catalog = await buildCatalog({ root, sourceCommit, tag, out: path.join(root, 'dist') });
  console.log(`Built ${catalog.entries.length} plugins from ${sourceCommit} for ${tag}`);
}
