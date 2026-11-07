import { createHash } from 'node:crypto';

const fail = message => { throw new Error(`invalid provenance: ${message}`); };
import { validateSchema } from './schema.mjs';

export function validateProvenance({ data, packagePath, manifest, read }) {
  try { validateSchema('provenance.schema.json', data); } catch(error) { fail(error.message); }
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
