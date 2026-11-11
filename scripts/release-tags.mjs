import { execFileSync } from 'node:child_process';

const stableVersionPattern = '(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)';
const stableVersion = new RegExp(`^${stableVersionPattern}$`);
const pluginTag = new RegExp(`^([a-z0-9][a-z0-9-]*)@(${stableVersionPattern})$`);
export const commitPattern = /^[a-f0-9]{40}$/;
export const sha256Pattern = /^[a-f0-9]{64}$/;
export const pluginKeyPattern = /^[a-z0-9][a-z0-9-]*$/;
export const repository = 'JieWaZi/neux-plugins';
export const releaseURL = (tag, name) => `https://github.com/${repository}/releases/download/${tag}/${name}`;

export function isStableVersion(version) {
  return typeof version === 'string' && stableVersion.exec(version)?.[0] === version;
}

export function parsePluginTag(tag) {
  const match = typeof tag === 'string' && pluginTag.exec(tag);
  if (!match || match[0] !== tag) throw new Error('release tag must be <key>@<stable SemVer>');
  return { key: match[1], version: match[2] };
}

export function verifyPluginTag({ root, tag, sourceCommit }) {
  const identity = parsePluginTag(tag);
  const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (!commitPattern.test(sourceCommit) || git(['rev-parse', '--verify', `refs/tags/${tag}^{commit}`]) !== sourceCommit) {
    throw new Error(`tag ${tag} does not identify ${sourceCommit}`);
  }
  try {
    git(['merge-base', '--is-ancestor', sourceCommit, 'refs/remotes/origin/main']);
  } catch (error) {
    throw new Error(`tag ${tag} must point to a commit on origin/main`, { cause: error });
  }
  return identity;
}
