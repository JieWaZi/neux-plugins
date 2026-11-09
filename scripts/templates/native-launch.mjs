// Generated into each package by scripts/sync-standalone.mjs.
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

const fail = code => { throw new Error(code); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const stable = value => JSON.stringify(value, (_key, item) => plain(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
async function bytes(filename, limit = 1024 * 1024) {
  const info = await lstat(filename).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > limit) fail('invalid_native_file');
  return readFile(filename);
}

// npm's .cmd is data here: never invoke cmd.exe or interpret a command string.
// Only its quoted Node entry is accepted, and package.json must declare that exact bin.
export async function resolveNativeCommand(command, args, { platform = process.platform, environment = process.env, node = process.execPath } = {}) {
  if (platform !== 'win32') return { executable: command, args: [...args] };
  let candidate = command;
  if (!path.isAbsolute(command) && !/[\\/]/.test(command)) {
    const search = Object.entries(environment).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
    candidate = undefined;
    for (const directory of search.split(';').filter(Boolean)) {
      for (const suffix of path.extname(command) ? [''] : ['.exe', '.com', '.cmd']) {
        const possible = path.join(directory.replace(/^"|"$/g, ''), command + suffix);
        if ((await lstat(possible).catch(() => undefined))?.isFile()) { candidate = possible; break; }
      }
      if (candidate) break;
    }
    if (!candidate) fail('cli_unavailable');
  }
  if (!/\.(?:cmd|bat)$/i.test(candidate)) return { executable: candidate, args: [...args] };
  if (!/\.cmd$/i.test(candidate)) fail('unsupported_npm_shim');
  const text = (await bytes(candidate, 65536)).toString('utf8');
  const entries = [...text.matchAll(/(?:"%_prog%"|"%dp0%[\\/]node\.exe")\s+"%dp0%[\\/]([^"\r\n]+)"\s+%\*/gi)].map(match => match[1]);
  if (/"%_prog%"/i.test(text) && !/set\s+"?_prog=(?:node|%dp0%[\\/]node\.exe)(?:"|\s|$)/i.test(text)) fail('unsupported_npm_shim');
  if (!entries.length || new Set(entries).size !== 1 || entries[0].includes('%')) fail('unsupported_npm_shim');
  const entry = await realpath(path.resolve(path.dirname(candidate), entries[0].replaceAll('\\', path.sep))).catch(() => fail('unsupported_npm_shim'));
  if (!(await lstat(entry)).isFile()) fail('unsupported_npm_shim');
  const key = path.basename(candidate).replace(/\.cmd$/i, '');
  for (let directory = path.dirname(entry); ; directory = path.dirname(directory)) {
    const manifestBytes = await readFile(path.join(directory, 'package.json')).catch(() => undefined);
    if (manifestBytes) {
      let manifest; try { manifest = JSON.parse(manifestBytes); } catch { fail('unsupported_npm_shim'); }
      const declared = typeof manifest.bin === 'string' && manifest.name?.split('/').at(-1) === key ? manifest.bin : manifest.bin?.[key];
      if (typeof declared === 'string') {
        const target = path.resolve(directory, declared);
        const relative = path.relative(directory, target);
        if (relative && !relative.startsWith('..') && !path.isAbsolute(relative) && await realpath(target).catch(() => undefined) === entry) return { executable: node, args: [entry, ...args] };
      }
    }
    if (path.dirname(directory) === directory) break;
  }
  fail('unsupported_npm_shim');
}

async function verifiedOpenCodeTarget(root, dataDirectory, previous) {
  root = await realpath(root); dataDirectory = await realpath(dataDirectory);
  const configBytes = await bytes(path.join(root, 'opencode.json'));
  const manifestBytes = await bytes(path.join(root, 'plugin.json'));
  if (previous && (previous.configSHA256 !== hash(configBytes) || previous.manifestSHA256 !== hash(manifestBytes))) fail('opencode_target_changed');
  const config = JSON.parse(configBytes), manifest = JSON.parse(manifestBytes);
  const auth = manifest.extensions?.['com.neuxbot']?.authentication;
  if (!auth || !plain(config) || Object.keys(config).some(key => !['skills', 'mcp'].includes(key)) || !plain(config.skills) || Object.keys(config.skills).some(key => key !== 'paths') || !Array.isArray(config.skills.paths) || !plain(config.mcp)) fail('invalid_opencode_target');
  const expectedSkills = new Set((auth.skillBindings ?? []).map(binding => `./${binding.skill}`));
  if (expectedSkills.size !== config.skills.paths.length) fail('invalid_opencode_target');
  const skills = [];
  for (const relative of config.skills.paths) {
    if (typeof relative !== 'string' || !/^\.\/skills\/[a-z0-9][a-z0-9-]*$/.test(relative) || !expectedSkills.delete(relative)) fail('invalid_opencode_target');
    const directory = path.join(root, relative);
    if (await realpath(directory) !== directory) fail('invalid_opencode_target');
    const skill = (await bytes(path.join(directory, 'SKILL.md'))).toString('utf8');
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(skill)?.[1];
    const name = frontmatter?.match(/^name:\s*["']?([a-z0-9][a-z0-9-]*)["']?\s*$/m)?.[1];
    if (!name) fail('invalid_opencode_target');
    skills.push({ key: name, directory });
  }
  const canonicalBytes = await readFile(path.join(root, 'mcp.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
  const canonical = canonicalBytes ? JSON.parse(canonicalBytes).mcpServers ?? {} : {};
  if (stable(Object.keys(canonical).sort()) !== stable(Object.keys(config.mcp).sort())) fail('invalid_opencode_target');
  for (const [key, server] of Object.entries(config.mcp)) {
    const source = canonical[key];
    // These maintained packages expose HTTP MCP or Skills. Do not merge arbitrary executable config.
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(key) || !plain(server) || Object.keys(server).some(key => !['type', 'url', 'headers', 'enabled'].includes(key)) || !['streamable-http', 'sse'].includes(source.type) || server.type !== 'remote' || server.url !== source.url || server.enabled !== true) fail('invalid_opencode_target');
    const expected = Object.fromEntries(Object.entries(source.headers ?? {}).map(([name, value]) => [name, value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, '{env:$1}')]));
    if (stable(expected) !== stable(server.headers ?? {})) fail('invalid_opencode_target');
    for (const [header, value] of Object.entries(expected)) if (value.includes('{env:GITHUB_PLUGIN_AUTHORIZATION}') && (key !== 'github' || server.url !== 'https://api.githubcopilot.com/mcp/' || !auth.bindings?.some(binding => binding.server === key && binding.url === server.url && binding.header === header))) fail('invalid_opencode_target');
    for (const binding of auth.bindings ?? []) if (binding.server === key && (binding.url !== server.url || !/^\{env:[A-Za-z_][A-Za-z0-9_]*\}$/.test(expected[binding.header] ?? ''))) fail('invalid_opencode_target');
  }
  return { root, dataDirectory, configSHA256: hash(configBytes), manifestSHA256: hash(manifestBytes), skills, mcp: config.mcp };
}

// Merge only the native targets carried by this setup chain, never an inherited arbitrary config.
// Retain placeholders for credentials; only package/data path placeholders are bound per target.
export async function prepareOpenCodeConfig({ root, dataDirectory, environment }) {
  const inherited = environment.NEUX_NATIVE_PLUGIN_TARGETS;
  let chain;
  try { chain = inherited ? JSON.parse(inherited) : []; } catch { fail('invalid_opencode_chain'); }
  if (!Array.isArray(chain) || chain.length > 32 || chain.some(item => !plain(item) || !path.isAbsolute(item.root ?? '') || !path.isAbsolute(item.dataDirectory ?? ''))) fail('invalid_opencode_chain');
  const targets = [];
  for (const record of chain) targets.push(await verifiedOpenCodeTarget(record.root, record.dataDirectory, record));
  const current = await verifiedOpenCodeTarget(root, dataDirectory);
  const existing = targets.find(item => item.root === current.root);
  if (existing && existing.dataDirectory !== current.dataDirectory) fail('opencode_account_conflict');
  if (!existing) targets.push(current);
  const combined = { skills: { paths: [] }, mcp: Object.create(null) }, seenSkills = new Set();
  for (const target of targets) {
    for (const skill of target.skills) {
      if (seenSkills.has(skill.key)) fail('opencode_skill_conflict');
      seenSkills.add(skill.key); combined.skills.paths.push(skill.directory);
    }
    for (const [key, server] of Object.entries(target.mcp)) {
      if (Object.hasOwn(combined.mcp, key)) fail('opencode_mcp_conflict');
      combined.mcp[key] = JSON.parse(JSON.stringify(server).replaceAll('{env:NEUXBOT_PLUGIN_ROOT}', JSON.stringify(target.root).slice(1, -1)).replaceAll('{env:NEUXBOT_PLUGIN_DATA}', JSON.stringify(target.dataDirectory).slice(1, -1)));
    }
  }
  const directory = await mkdtemp(path.join(current.dataDirectory, 'opencode-run-'));
  try {
    const filename = path.join(directory, 'opencode.json');
    await writeFile(filename, `${JSON.stringify(combined, null, 2)}\n`, { mode: 0o600 });
    const records = targets.map(({ root, dataDirectory, configSHA256, manifestSHA256 }) => ({ root, dataDirectory, configSHA256, manifestSHA256 }));
    return { environment: { OPENCODE_CONFIG: filename, NEUX_NATIVE_PLUGIN_TARGETS: JSON.stringify(records), NEUXBOT_PLUGIN_ROOT: current.root, NEUXBOT_PLUGIN_DATA: current.dataDirectory }, cleanup: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
