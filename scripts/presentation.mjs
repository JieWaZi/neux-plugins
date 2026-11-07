import { inflateSync } from 'node:zlib';
import { validateSchema } from './schema.mjs';

const maxIconBytes = 256 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function crc32(content) {
  let value = 0xffffffff;
  for (const byte of content) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); }
  return (value ^ 0xffffffff) >>> 0;
}

// 发布只接受有界、非交错的 8 位 PNG，校验块、像素数据及过滤器后才内嵌目录。
function pngIcon(content) {
  const invalid = () => { throw new Error('invalid PNG icon asset'); };
  if (content.length > maxIconBytes || !content.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) invalid();
  let offset = 8, rowBytes = 0, height = 0, ended = false, dataEnded = false; const compressed = [];
  while (offset < content.length) {
    if (content.length - offset < 12) invalid();
    const size = content.readUInt32BE(offset), end = offset + 12 + size;
    if (end > content.length) invalid();
    const type = content.toString('ascii', offset + 4, offset + 8);
    const data = content.subarray(offset + 8, offset + 8 + size);
    if (!/^[A-Za-z]{4}$/.test(type) || crc32(content.subarray(offset + 4, offset + 8 + size)) !== content.readUInt32BE(offset + 8 + size)) invalid();
    if (offset === 8 && type !== 'IHDR') invalid();
    if (type === 'IHDR') {
      if (offset !== 8 || size !== 13) invalid();
      const width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[data[9]];
      if (width < 1 || height < 1 || width > 2048 || height > 2048 || data[8] !== 8 || !channels || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) invalid();
      rowBytes = width * channels + 1;
    } else if (type === 'IDAT') {
      if (dataEnded) invalid();
      compressed.push(data);
    } else if (type === 'IEND') {
      if (size !== 0 || end !== content.length || !compressed.length) invalid();
      ended = true;
    } else {
      if (compressed.length) dataEnded = true;
      if (type[0] === type[0].toUpperCase() && type !== 'PLTE') invalid();
      if (['acTL', 'fcTL', 'fdAT'].includes(type)) invalid();
    }
    offset = end;
  }
  if (!ended) invalid();
  let pixels;
  try { pixels = inflateSync(Buffer.concat(compressed), { maxOutputLength: rowBytes * height }); } catch { invalid(); }
  if (pixels.length !== rowBytes * height) invalid();
  for (let row = 0; row < height; row++) if (pixels[row * rowBytes] > 4) invalid();
  return `data:image/png;base64,${content.toString('base64')}`;
}

// 标准 interface 是作者唯一来源；本地化资料必须由新宿主扩展显式引用。
export function catalogPresentation({ manifest, packagePath, has, read }) {
  validateSchema('openai-plugin.schema.json', manifest.extensions?.['com.openai'] ?? {});
  const source = manifest.extensions?.['com.openai']?.interface ?? {};
  const result = { displayName: source.displayName || manifest.name, shortDescription: source.shortDescription || manifest.description || '', developerName: source.developerName || manifest.author?.name || '' };
  for (const key of ['longDescription', 'category', 'websiteURL', 'privacyPolicyURL', 'termsOfServiceURL', 'supportURL']) if (source[key]) result[key] = source[key];
  if (source.defaultPrompt !== undefined) result.defaultPrompt = typeof source.defaultPrompt === 'string' ? [source.defaultPrompt] : [...source.defaultPrompt];
  if (source.capabilities) result.capabilities = [...source.capabilities];
  if (source.brandColor || source.brandColorDark) result.brandColor = { ...(source.brandColor ? { default: source.brandColor } : {}), ...(source.brandColorDark ? { dark: source.brandColorDark } : {}) };
  const icons = { default: source.logo ?? source.composerIcon, dark: source.logoDark ?? source.composerIconDark };
  if (icons.default || icons.dark) {
    result.icons = {};
    for (const [theme, value] of Object.entries(icons)) {
      if (value === undefined) continue;
      if (typeof value !== 'string' || !/^\.\/assets\/(?:[^/\\:\x00-\x1f]+\/)*[^/\\:\x00-\x1f]+\.png$/.test(value) || value.split('/').slice(1).some(part => part === '.' || part === '..')) throw new Error('invalid icon asset path');
      result.icons[theme] = pngIcon(read(`${packagePath}/${value.slice(2)}`));
    }
    result.icon = result.icons.default;
  }
  const referencePath = manifest.extensions?.['com.neuxbot']?.presentation;
  if (referencePath) {
    const filename = `${packagePath}/${referencePath.replace(/^\.\//, '')}`;
    if (!has(filename)) throw new Error('declared presentation is missing');
    const bytes = read(filename); if (bytes.length > 1024 * 1024) throw new Error('presentation metadata too large');
    const localized = JSON.parse(bytes); validateSchema('neuxbot-presentation.schema.json', localized);
    for (const key of ['displayNames', 'localizedDescriptions', 'defaultPromptLocalizations', 'setup']) if (localized[key]) result[key] = structuredClone(localized[key]);
    for (const translations of Object.values(localized.defaultPromptLocalizations ?? {})) if (translations.length !== (result.defaultPrompt?.length ?? 0)) throw new Error('localized defaultPrompt array length differs from standard prompts');
  }
  return result;
}
