import { parseDocument } from 'yaml';
import { validateSchema } from './schema.mjs';

export const maxDetailsBytes = 4 * 1024 * 1024;
const maxDocumentBytes = 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error(`invalid plugin details: ${message}`); };
const text = value => typeof value === 'string' && value.trim() ? value : undefined;
const pick = (value, keys) => Object.fromEntries(keys.filter(key => text(value?.[key]) !== undefined).map(key => [key, value[key]]));
const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string') ? [...value] : [];

// 服务摘要不展示含凭据、查询参数或片段的地址；执行配置仍只保存在安装归档。
function publicURL(value) {
  if (!text(value) || /[\x00-\x20\x7f]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return undefined;
    return value;
  } catch { return undefined; }
}

function relative(value) {
  if (typeof value !== 'string') fail('component path must be a string');
  const result = value.replace(/^\.\//, '').replace(/\/$/, '');
  if (!result || result.includes('\\') || result.includes(':') || /[\x00-\x1f]/.test(result) || result.split('/').some(part => !part || part === '.' || part === '..')) fail('unsafe component path');
  return result;
}

function document(bytes, label) {
  if (!bytes || bytes.length > maxDocumentBytes) fail(`${label} too large or missing`);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail(`${label} is not valid UTF-8`); }
}

function skillMetadata(content, label) {
  const frontmatter = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(content);
  if (!frontmatter) fail(`skill frontmatter missing: ${label}`);
  const parsed = parseDocument(frontmatter[1], { uniqueKeys: true, version: '1.2' });
  if (parsed.errors.length || parsed.warnings.length) fail(`skill YAML invalid: ${label}`);
  let metadata;
  try { metadata = parsed.toJS({ maxAliasCount: 50 }); } catch { fail(`skill YAML aliases invalid: ${label}`); }
  if (!object(metadata) || !text(metadata.name) || !text(metadata.description)) fail(`skill YAML name/description must be strings: ${label}`);
  return { name: metadata.name, description: metadata.description };
}

// 仅从标准清单与实际文件派生只读资料；不复制程序入口、秘密绑定和未知扩展。
export function packageDetails({ sourceCommit, archiveSHA256, packagePath, manifest, presentation, provenance, names, has, read }) {
  for (const value of [provenance.upstream.repository, provenance.upstream.distribution?.url].filter(value => value !== undefined)) if (!publicURL(value)) fail('upstream source URL must be public');
  const manifestInfo = { $schema: manifest.$schema, ...pick(manifest, ['name', 'version', 'description', 'license']) };
  manifestInfo.author = pick(manifest.author, ['name', 'email']);
  if (publicURL(manifest.author?.url)) manifestInfo.author.url = manifest.author.url;
  for (const field of ['homepage', 'repository']) if (publicURL(manifest[field])) manifestInfo[field] = manifest[field];
  manifestInfo.keywords = strings(manifest.keywords);
  const display = {};
  for (const field of ['displayName', 'shortDescription', 'longDescription', 'developerName', 'category', 'websiteURL', 'privacyPolicyURL', 'termsOfServiceURL', 'supportURL', 'defaultPrompt', 'defaultPromptLocalizations', 'capabilities', 'brandColor', 'icons', 'displayNames', 'localizedDescriptions', 'setup']) if (presentation[field] !== undefined) display[field] = structuredClone(presentation[field]);
  display.displayName ??= manifest.name; display.shortDescription ??= manifest.description;
  const pkg = { contractVersion: 'neuxbot-plugin/1', manifest: manifestInfo, format: 'agent-plugins', presentation: display, upstream: structuredClone(provenance.upstream), skills: [], servers: [], diagnostics: [] };
  if (text(presentation.icon)) pkg.icon = presentation.icon;
  const readmes = {}, skillContents = {};
  for (const [locale, filename] of [['en', 'README.md'], ['zh-CN', 'README.zh-CN.md']]) if (has(`${packagePath}/${filename}`)) readmes[locale] = document(read(`${packagePath}/${filename}`), filename);
  const files = names(); const skillPaths = new Set();
  function discover(value) {
    const root = relative(value);
    const prefix = `${packagePath}/${root}/`;
    for (const name of files) if (name.startsWith(prefix) && /^[^/]+\/SKILL\.md$/.test(name.slice(prefix.length))) skillPaths.add(name.slice(packagePath.length + 1, -'/SKILL.md'.length));
  }
  discover('skills');
  for (const path of [...skillPaths].sort()) {
    const content = document(read(`${packagePath}/${path}/SKILL.md`), `skill ${path}`);
    pkg.skills.push({ key: path, ...skillMetadata(content, path), path }); skillContents[path] = content;
  }
  if (has(`${packagePath}/mcp.json`)) {
    const mcp = JSON.parse(document(read(`${packagePath}/mcp.json`), 'MCP metadata'));
    for (const key of Object.keys(mcp.mcpServers).sort()) {
      const server = mcp.mcpServers[key], summary = { key, type: server.type };
      if (server.type !== 'stdio') { const url = new URL(server.url); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; summary.url = url.href; }
      const auth = server.extensions?.['com.openai']?.auth;
      if (auth) summary.authentication = pick(auth, ['type', 'headerScheme', 'headerName']);
      pkg.servers.push(summary);
    }
  }
  const auth = manifest.extensions?.['com.neuxbot']?.authentication;
  if (auth) pkg.integration = { authentication: { ...pick(auth, ['strategy', 'protocol', 'preferredAction']), scopes: strings(auth.scopes) } };
  const result = { schemaVersion: 1, sourceCommit, archiveSHA256, packagePath, package: pkg, readmes, skillContents };
  validateSchema('details.schema.json', result); return result;
}

export function encodeDetails(value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  if (bytes.length > maxDetailsBytes) fail('details size exceeds 4 MiB');
  return bytes;
}
