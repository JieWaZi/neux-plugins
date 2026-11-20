import { createHash } from 'node:crypto';

const fail = message => { throw new Error(`invalid provenance: ${message}`); };
import { validateSchema } from './schema.mjs';

export function validateProvenance({ data, packagePath, manifest, read }) {
  try { validateSchema('provenance.schema.json', data); } catch(error) { fail(error.message); }
  if (data.upstream.distribution.mode === 'local-service') validateLocalService(data.upstream.distribution.url, packagePath, manifest, read);
  if (manifest.author?.name && manifest.author.name !== data.wrapper.maintainer) fail('wrapper maintainer differs from manifest author');
  if (manifest.license && manifest.license !== data.wrapper.license) fail('wrapper license differs from manifest license');
  const assets = new Set();
  for (const asset of data.assets) {
    if (assets.has(asset.path)) fail('duplicate asset path');
    assets.add(asset.path);
    if (createHash('sha256').update(read(`${packagePath}/${asset.path}`)).digest('hex') !== asset.sha256) fail(`asset sha256 digest mismatch: ${asset.path}`);
  }
  for (const reference of ['logo', 'logoDark', 'composerIcon', 'composerIconDark'].map(key => manifest.extensions?.['com.openai']?.interface?.[key]).filter(Boolean)) {
    if (!reference.startsWith('./assets/') || !assets.has(reference.slice(2))) fail(`manifest icon lacks local asset provenance: ${reference}`);
  }
  const dependencies = new Set();
  for (const dependency of data.dependencies) {
    if (dependencies.has(dependency.name)) fail('duplicate dependency name');
    dependencies.add(dependency.name);
    const lock = JSON.parse(read(`${packagePath}/${dependency.lock}`));
    if (lock.version !== dependency.version || lock.source?.repository !== dependency.repository || lock.source?.commit !== dependency.commit) fail(`dependency lock source or version mismatch: ${dependency.name}`);
  }
  return data;
}


function validateLocalService(url, packagePath, manifest, read) {
  let address;
  try { address = new URL(url); } catch { fail('local-service requires a fixed numeric loopback HTTP URL'); }
  const loopback = address.hostname === '[::1]' || /^127(?:\.[0-9]{1,3}){3}$/.test(address.hostname);
  if (!loopback || address.protocol !== 'http:' || address.href !== url ||
      address.username || address.password || /[?#%]/.test(url)) {
    fail('local-service requires a fixed numeric loopback HTTP URL');
  }

  let servers;
  try { servers = JSON.parse(read(`${packagePath}/mcp.json`)).mcpServers; }
  catch { fail('local-service requires an exact declared MCP component'); }
  const server = Object.values(servers ?? {}).find(component => component?.type === 'streamable-http' && component.url === url);
  if (!server) fail('local-service requires an exact declared MCP component');

  const auth = server.extensions?.['com.openai']?.auth;
  const extension = manifest.extensions?.['com.neuxbot'];
  if ((auth && auth.type !== 'none') || Object.keys(server.headers ?? {}).length !== 0 ||
      extension?.authentication !== undefined || extension?.configuration !== undefined) {
    fail('local-service requires credential-free MCP access');
  }
}
