import { buildCatalog } from './build-catalog.mjs';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 只提交独立临时副本；指定持久输出后，重启不依赖临时目录或真实工作区提交。
export async function buildReviewSnapshot({ root, out }) {
  const relative = path.relative(root, out).split(path.sep);
  if (relative[0] !== '.cache' || relative.length < 2)
    throw new Error('Development output must stay below repository .cache');
  const temporary = await mkdtemp(
    path.join(tmpdir(), 'neux-standard-artifact-source-'),
  );
  const source = path.join(temporary, 'source');
  try {
    await cp(root, source, {
      recursive: true,
      filter: (name) => {
        const relative = path.relative(root, name);
        return !['.git', 'node_modules', 'dist', '.cache'].includes(
          relative.split(path.sep)[0],
        );
      },
    });
    const git = (args) =>
      execFileSync('git', ['-C', source, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
          GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
        },
      }).trim();
    git(['init', '--quiet']);
    git(['add', '--all']);
    git([
      '-c',
      'user.name=Plugin contract verification',
      '-c',
      'user.email=plugin-contract@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      'Stage one contract verification snapshot',
    ]);
    const sourceCommit = git(['rev-parse', 'HEAD']);
    const catalog = await buildCatalog({ root: source, sourceCommit, out });
    return {
      sourceCommit,
      out,
      entries: catalog.entries.map(
        ({ key, archiveSHA256, detailsSHA256, detailsSize }) => ({
          key,
          archiveSHA256,
          detailsSHA256,
          detailsSize,
        }),
      ),
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--out'))
    throw new Error(
      'Usage: node scripts/build-review-snapshot.mjs [--out directory]',
    );
  const out = args.length
    ? path.resolve(args[1])
    : path.join(root, '.cache/development/catalog');
  console.log(
    JSON.stringify(await buildReviewSnapshot({ root, out }), null, 2),
  );
}
