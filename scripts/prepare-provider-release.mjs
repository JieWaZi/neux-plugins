import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = 'https://github.com/JieWaZi/neux-plugins';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// Relocating verified provider bytes changes transport only, never provider identity or provenance.
export async function retargetProviderAssets({ root, assets, tag }) {
  if (!/^v\d+\.\d+\.\d+(?:[-.][a-zA-Z0-9.-]+)?$/.test(tag)) throw new Error('fixed release tag required');
  const pending = [];
  let verified = 0;
  for (const key of ['feishu-office', 'github']) {
    const filename = path.join(root, 'plugins', key, '.neuxbot/auth/assets.lock.json');
    const lock = JSON.parse(await readFile(filename, 'utf8'));
    if (lock.schemaVersion !== 1 || !lock.notices || !lock.assets || !Object.keys(lock.assets).length) throw new Error('invalid provider lock');
    for (const asset of [lock.notices, ...Object.values(lock.assets)]) {
      const match = /^https:\/\/github\.com\/JieWaZi\/neux-plugins\/releases\/download\/v[0-9A-Za-z.-]+\/([A-Za-z0-9._-]+)$/.exec(asset.url);
      if (!match || match[1] === '.' || match[1] === '..') throw new Error('invalid maintained asset URL');
      const file = path.join(assets, match[1]);
      const info = await lstat(file);
      if (!info.isFile()) throw new Error('provider asset must be a regular file');
      if (info.size <= 0 || asset.size !== undefined && (!Number.isSafeInteger(asset.size) || info.size !== asset.size)) throw new Error('provider size mismatch');
      const bytes = await readFile(file);
      if (bytes.length !== info.size || digest(bytes) !== asset.sha256) throw new Error('provider digest mismatch');
      asset.url = `${repository}/releases/download/${tag}/${match[1]}`;
      verified++;
    }
    pending.push({ filename, bytes: `${JSON.stringify(lock, null, 2)}\n` });
  }
  // Validate every program and notice before changing either generated lock.
  for (const item of pending) await writeFile(item.filename, item.bytes);
  return { tag, providers: pending.length, verifiedAssets: verified };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--assets' || args[2] !== '--tag') throw new Error('usage: prepare-provider-release.mjs --assets <verified-directory> --tag <fixed-release>');
  const root = fileURLToPath(new URL('..', import.meta.url));
  console.log(JSON.stringify(await retargetProviderAssets({ root, assets: path.resolve(args[1]), tag: args[3] })));
}
