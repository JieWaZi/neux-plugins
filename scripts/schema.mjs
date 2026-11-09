import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const schemaRoot = new URL('../schemas/', import.meta.url);
const lock = JSON.parse(readFileSync(new URL('schema-lock.json', schemaRoot), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const schemas = new Map();
for (const entry of lock.schemas) {
  const bytes = readFileSync(new URL(entry.path, schemaRoot));
  if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error(`schema SHA256 mismatch: ${entry.path}`);
  const schema = JSON.parse(bytes); schemas.set(entry.path, schema); ajv.addSchema(schema, entry.path);
}
export function validateSchema(name, value) {
  const validate = ajv.getSchema(name); if (!validate || !validate(value)) throw new Error(`invalid ${name}: ${ajv.errorsText(validate?.errors, { separator: '; ' })}`);
  return value;
}
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const safePath = value => typeof value === 'string' && value && !value.includes('\\') && !value.includes(':') && value.replace(/^\.\//, '').split('/').every(part => part && part !== '.' && part !== '..' && !part.includes('\0'));
const secretKey = key => /^(?:HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PWD|OLDPWD|SHELL|ENV|BASH_ENV|ZDOTDIR|PLUGIN_ROOT|PLUGIN_DATA|GOROOT|GOPATH)$/.test(key) || /^(?:LD_|DYLD_|PYTHON|NEUXALLY_|NEUXBOT_|ALLY|CODEX|CLAUDE|NODE_)/.test(key);

// 官方1.0 MCP核心不含OpenAI命名空间；分别校验锁定核心和OpenAI扩展，不改官方Schema字节。
export function validateStandardPackage({ manifest, packagePath, names, has, read }) {
  validateSchema('agent-plugins-1.0.0.schema.json', manifest);
  for (const name of names()) if (name.startsWith(`${packagePath}/`) && /^(?:\.codex-plugin|\.claude-plugin|\.neuxally|hooks|agents|commands)(?:\/|$)|^(?:\.mcp\.json|\.app\.json|\.lsp\.json)$/.test(name.slice(packagePath.length + 1))) throw new Error(`unsupported legacy or executable component: ${name}`);
  if (manifest.extensions?.['com.ally'] || manifest.extensions?.['com.neuxally']) throw new Error('unsupported legacy namespace');
  if (manifest.extensions?.['com.openai']) validateSchema('openai-plugin.schema.json', manifest.extensions['com.openai']);
  const extension = manifest.extensions?.['com.neuxbot'];
  if (extension) {
    if (extension.management !== undefined) throw new Error('unsupported management capability in phase one');
    validateSchema('neuxbot-extension.schema.json', extension);
    const configuration = extension.configuration ?? {}, fields = new Map();
    for (const field of configuration.fields ?? []) { if (fields.has(field.key) || ['PLUGIN_ROOT', 'PLUGIN_DATA'].includes(field.key)) throw new Error('duplicate or reserved configuration field'); fields.set(field.key, field); }
    for (const binding of configuration.bindings ?? []) for (const [, key] of binding.value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) if (!fields.has(key)) throw new Error('configuration binding uses an undeclared field');
    if (extension.presentation) {
      if (!safePath(extension.presentation) || !extension.presentation.replace(/^\.\//, '').startsWith('.neuxbot/')) throw new Error('presentation must stay inside .neuxbot');
      const bytes = read(`${packagePath}/${extension.presentation.replace(/^\.\//, '')}`); if (bytes.length > 1024 * 1024) throw new Error('presentation metadata too large');
      const localized = JSON.parse(bytes); validateSchema('neuxbot-presentation.schema.json', localized);
      const rawPrompt = manifest.extensions?.['com.openai']?.interface?.defaultPrompt;
      const prompts = typeof rawPrompt === 'string' ? [rawPrompt] : rawPrompt ?? [];
      for (const values of Object.values(localized.defaultPromptLocalizations ?? {})) if (values.length !== prompts.length) throw new Error('localized defaultPrompt array length differs from standard prompts');
    }
    const auth = extension.authentication;
    if (auth) {
      const entry = auth.command === 'node' ? auth.args?.[0] : auth.command;
      if (!safePath(entry) || entry.startsWith('-') || !has(`${packagePath}/${entry.replace(/^\.\//, '')}`)) throw new Error('authentication entry escapes or is missing');
      const boundSkills = new Set();
      for (const binding of auth.skillBindings ?? []) {
        const identity = `${binding.runtime ?? "*"}:${binding.skill}`;
        if (boundSkills.has(identity) || !safePath(binding.skill) || !binding.skill.startsWith('skills/') || !has(`${packagePath}/${binding.skill}/SKILL.md`)) throw new Error('unknown or duplicate skill authentication binding'); boundSkills.add(identity);
        const keys = new Set(); const privateKeys = new Set(binding.privatePathKeys ?? []);
        if (privateKeys.size !== (binding.privatePathKeys ?? []).length) throw new Error('duplicate private path key');
        for (const key of binding.environmentKeys) { if (keys.has(key.toUpperCase()) || secretKey(key.toUpperCase()) || (key.toUpperCase() === 'PATH' && !privateKeys.has(key))) throw new Error('unsafe skill environment key'); keys.add(key.toUpperCase()); }
        for (const key of privateKeys) if (!binding.environmentKeys.includes(key)) throw new Error('private path key not declared as environment');
      }
    }
  }
  const mcpPath = `${packagePath}/mcp.json`; let servers = {};
  if (has(mcpPath)) {
    const mcp = JSON.parse(read(mcpPath)), portable = structuredClone(mcp); servers = mcp.mcpServers ?? {};
    for (const server of Object.values(portable.mcpServers ?? {})) delete server.extensions;
    validateSchema('agent-plugins-mcp-1.0.0.schema.json', portable);
    for (const [key, server] of Object.entries(servers)) {
      if (!key) throw new Error('empty MCP component key');
      if (server.type === 'stdio') {
        if (/\s|\$\{|\0/.test(server.command) || ((server.command.includes('/') || server.command.includes('\\')) && (!server.command.startsWith('./') || !safePath(server.command) || !has(`${packagePath}/${server.command.slice(2)}`)))) throw new Error('invalid standard MCP command or component path');
        if (server.cwd) {
          const value = server.cwd.replace(/^\$\{PLUGIN_ROOT\}(?=\/|$)/, '.');
          if (value.startsWith('${PLUGIN_DATA}')) { const suffix = value.slice('${PLUGIN_DATA}'.length); if ((suffix && !suffix.startsWith('/')) || suffix.split('/').some(part => part === '..')) throw new Error('escaping persistent MCP cwd'); }
          else if (!(value === '.' || value === './' || (value.startsWith('./') && safePath(value) && names().some(name => name.startsWith(`${packagePath}/${value.slice(2).replace(/\/$/, '')}/`))))) throw new Error('MCP working directory is missing or escaping');
        }
      } else {
        let address; try { address = new URL(server.url); } catch { throw new Error('invalid MCP URL'); }
        const loopback = address.hostname === 'localhost' || address.hostname === '[::1]' || /^127\.(?:[0-9]+\.){2}[0-9]+$/.test(address.hostname);
        if (!['https:', 'http:'].includes(address.protocol) || address.username || address.password || address.hash || (address.protocol === 'http:' && !loopback)) throw new Error('MCP URL violates transport boundary');
        for (const [name, value] of Object.entries(server.headers ?? {})) if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\x00-\x08\x0a-\x1f\x7f]/.test(value)) throw new Error('invalid MCP HTTP header');
      }
      if (server.extensions) { if (!object(server.extensions)) throw new Error('invalid MCP extension'); if (server.extensions['com.openai']) validateSchema('openai-mcp.schema.json', server.extensions['com.openai']); }
      const auth = server.extensions?.['com.openai']?.auth;
      if (auth && ['oauth', 'mixed'].includes(auth.type)) throw new Error('unsupported MCP authentication mode in phase one');
      if (auth?.type === 'api_key') {
        if (server.type === 'stdio') throw new Error('unsupported stdio API key');
        const header = auth.headerScheme === 'custom_header' ? auth.headerName : 'Authorization';
        const prefix = auth.headerScheme === 'bearer' ? 'Bearer ' : auth.headerScheme === 'basic' ? 'Basic ' : '';
        const binding = extension?.configuration?.bindings?.find(binding => binding.server === key && binding.target === 'header' && binding.name.toLowerCase() === header.toLowerCase());
        const credential = binding?.value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/) ?? binding?.value.slice(prefix.length).match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
        const field = extension?.configuration?.fields?.find(field => field.key === credential?.[1]);
        const driver = extension?.authentication?.bindings?.some(binding => binding.server === key && binding.url === server.url && binding.header.toLowerCase() === header.toLowerCase());
        if (!driver && (!binding || !binding.value.startsWith(prefix) || !field?.secret || !field.required)) throw new Error('API key lacks explicit required secret header binding');
      }
    }
  }
  const identities = new Set();
  for (const binding of extension?.configuration?.bindings ?? []) {
    const server = servers[binding.server], identity = `${binding.server}:${binding.target}:${binding.name.toLowerCase()}`;
    if (!server || identities.has(identity) || (binding.target === 'env') !== (server.type === 'stdio')) throw new Error('configuration binding has unknown server or transport'); identities.add(identity);
  }
  identities.clear();
  for (const binding of extension?.authentication?.bindings ?? []) {
    const server = servers[binding.server], identity = `${binding.runtime ?? "*"}:${binding.server}:${binding.header.toLowerCase()}`;
    if (!server || server.type === 'stdio' || binding.url !== server.url || identities.has(identity)) throw new Error('authentication binding target mismatch'); identities.add(identity);
  }
  return manifest;
}
