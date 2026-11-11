import { setTimeout } from 'node:timers/promises';
import { digest } from './release-artifacts.mjs';
import { releaseURL, repository } from './release-tags.mjs';

const apiRoot = `https://api.github.com/repos/${repository}`;
const uploadsRoot = `https://uploads.github.com/repos/${repository}`;

function assertOK(response, method, url) {
  if (!response.ok) throw new Error(`GitHub ${method} ${url} returned HTTP ${response.status}`);
}

export function assetBinding(release, name) {
  const assets = release.assets.filter(asset => asset.name === name);
  const [asset] = assets;
  if (assets.length !== 1 || asset.state !== 'uploaded' || !/^sha256:[a-f0-9]{64}$/.test(asset.digest) ||
      !Number.isSafeInteger(asset.size) || asset.size <= 0) {
    throw new Error(`missing or invalid release asset digest: ${release.tag_name}/${name}`);
  }
  return { name, size: asset.size, sha256: asset.digest.slice('sha256:'.length) };
}

export class GitHubReleases {
  constructor({ token, fetcher = fetch, wait = setTimeout }) {
    if (!token) throw new Error('GitHub token is required');
    this.token = token;
    this.fetcher = fetcher;
    this.wait = wait;
  }

  async #request(route, { method = 'GET', json, upload, missing = false } = {}) {
    const url = `${upload ? uploadsRoot : apiRoot}${route}`;
    const headers = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (upload) headers['Content-Type'] = upload.name.endsWith('.zip') ? 'application/zip' : 'application/json';
    if (json) headers['Content-Type'] = 'application/json';
    const response = await this.fetcher(url, {
      method, headers, body: upload?.bytes ?? (json && JSON.stringify(json)),
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(120000),
    });
    if (missing && response.status === 404) return undefined;
    assertOK(response, method, url);
    if (response.status !== 204) return response.json();
  }

  latestRelease() {
    return this.#request('/releases/latest');
  }

  releaseByTag(tag) {
    return this.#request(`/releases/tags/${encodeURIComponent(tag)}`, { missing: true });
  }

  releaseByID(id) {
    return this.#request(`/releases/${id}`);
  }

  async findRelease(tag) {
    const release = await this.releaseByTag(tag);
    if (release) return release;
    // GitHub's tag endpoint may only return published Releases.
    const pageSize = 100;
    for (let page = 1; ; page++) {
      const releases = await this.#request(`/releases?per_page=${pageSize}&page=${page}`);
      const matches = releases.filter(release => release.tag_name === tag);
      if (matches.length > 1) throw new Error(`multiple Releases for tag: ${tag}`);
      if (matches.length === 1) return matches[0];
      if (releases.length < pageSize) return undefined;
    }
  }

  async verifyTag(tag, sourceCommit) {
    const commit = await this.#request(`/commits/${encodeURIComponent(`refs/tags/${tag}`)}`);
    if (commit.sha !== sourceCommit) throw new Error(`tag ${tag} does not identify ${sourceCommit}`);
  }

  createDraft({ tag, targetCommitish, body }) {
    return this.#request('/releases', {
      method: 'POST',
      json: { tag_name: tag, target_commitish: targetCommitish, name: tag, body, draft: true, prerelease: false, make_latest: 'false' },
    });
  }

  publish(release, latest) {
    return this.#request(`/releases/${release.id}`, {
      method: 'PATCH', json: { draft: false, make_latest: latest ? 'true' : 'false' },
    });
  }

  upload(release, asset) {
    return this.#request(`/releases/${release.id}/assets?name=${encodeURIComponent(asset.name)}`, { method: 'POST', upload: asset });
  }

  discardStarter(asset) {
    return this.#request(`/releases/assets/${asset.id}`, { method: 'DELETE' });
  }

  async download(url, { size, sha256 }) {
    const response = await this.fetcher(url, {
      cache: 'no-store', redirect: 'follow', signal: AbortSignal.timeout(120000),
    });
    assertOK(response, 'GET', url);
    if (response.url && new URL(response.url).protocol !== 'https:') throw new Error(`insecure release asset redirect: ${url}`);
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > size) throw new Error(`release asset digest or size mismatch: ${url}`);
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks, length);
    if (length !== size || digest(bytes) !== sha256) throw new Error(`release asset digest or size mismatch: ${url}`);
    return bytes;
  }

  downloadAsset(release, asset) {
    return this.download(releaseURL(release.tag_name, asset.name), asset);
  }

  async retryRead(read) {
    for (const waitMs of [1000, 2000, 4000, 8000]) {
      try {
        return await read();
      } catch {
        await this.wait(waitMs);
      }
    }
    return read();
  }
}
