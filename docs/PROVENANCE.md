# Maintained package provenance

[English](PROVENANCE.md) | [简体中文](PROVENANCE.zh-CN.md)

Every maintained package owns `provenance.json` with the same [schema](../schemas/provenance.schema.json). This is source and presentation evidence, not a replacement plugin manifest or a native-source reference loader. Standard identity, internal package version and component definitions remain in `.codex-plugin/plugin.json`, Skills and MCP files. The host reads the declared upstream facts directly; do not infer them from a plugin name, capability brand or authorization program.

| Layer | Required facts | Responsibility |
| --- | --- | --- |
| `schemaVersion` | `1` | Version of this provenance structure |
| `upstream` | `author`, `repository`, `license`, `distribution` | Business capability source; the only source for developer, displayed version, license and source link |
| `wrapper` | `maintainer`, `repository`, `license`, English `changes[]` | Maintained package and integration bridge authorship; developer evidence, not user-facing capability metadata |
| `dependencies[]` | `name`, `repository`, fixed `commit`, `version`, `license`, package-relative `lock` | Isolated authorization/runtime programs; versions are never substituted for capability versions |
| `assets[]` | Package-relative `path`, `sourceURL`, byte `sha256`, `license`, `attribution` | Locally maintained brand assets; optional archive `sourcePath`/`sourceSHA256` and `licenseURL` retain exact extraction evidence |

`author`, `repository`, `license`, and optional `tag`/`version`/`commit` in `upstream` are strings. `tag` takes display precedence over `version`; do not normalize away its `v` prefix. The Feishu developer is `Lark Suite CLI contributors`, and its displayed plugin version is `v1.0.98`. Show one version field from that declaration, not a separate upstream-version field and internal `0.1.0`. The maintained package version and `v0.1.x` library release series continue to identify archives and installed snapshots internally. They are not the user-facing capability version.

## Source distribution modes

- `distribution.mode: vendored-source`: reviewed source, skills or other business implementation is copied into the maintained package. A full lowercase 40-character `commit` is required; record the true source `tag` or `version` when available. Preserve source-relative resources, original licenses and explicit wrapper changes. Do not fetch upstream content during a catalog build or installation.
- `distribution.mode: hosted-service`: the package declares a service at `distribution.url` rather than redistributing its implementation. Do not set `commit`, `tag` or `version` for an unpinned hosted service. GitHub uses its official hosted MCP endpoint; GitHub CLI is a separate authorization dependency with its own lock. The host leaves the absent capability version unspecified. The upstream project license does not grant rights to its hosted service or trademarks.

Example shape (replace illustrative facts with verified values):

```json
{
  "schemaVersion": 1,
  "upstream": {
    "author": "Project contributors",
    "repository": "https://github.com/example/project",
    "license": "MIT",
    "commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "tag": "v1.2.3",
    "distribution": { "mode": "vendored-source" }
  },
  "wrapper": {
    "maintainer": "NeuxBot contributors",
    "repository": "https://github.com/JieWaZi/neux-plugins",
    "license": "MIT",
    "changes": ["Maintained standard manifest and authorization bridge"]
  },
  "dependencies": [],
  "assets": []
}
```

## Validation and updates

The builder reads the fixed commit, validates every package's required provenance against the shared schema, verifies dependency repository/commit/version against its actual asset lock, and hashes declared local assets. Both manifest icon fields must reference a declared local asset. Unknown fields, legacy `packaging`/`capability`/`logo`/`cli` top-level layouts, missing source commits, malformed values, Chinese `wrapper.changes`, digest drift and source/lock disagreement fail before replacing output. `scripts/provenance.mjs` implements the simple schema keywords used here; extend the validator and regression cases together when extending the schema.

Brand icons are copied into each package's `assets/` directory after reviewing their official source and usage terms. The catalog embeds their verified bytes for discovery before installation. No runtime image request or supplier plugin marketplace is involved. Copying a mark is not claiming authorship or applying the wrapper's MIT license to that mark. Preserve actual source and applicable brand terms in this file's asset records and [third-party notices](../THIRD_PARTY_NOTICES.md).

A maintainer collecting new capability content must inspect upstream facts, copy the needed content, document actual modifications and licenses, supply English and Chinese business documentation, and verify the package-owned authorization bridge against the generic host protocol. Only reviewed maintained packages enter the published catalog. Changes to provider programs require their isolation and asset-lock checks; changing provenance or icon does not justify silently rebuilding unrelated providers. A pinned version means verified source, not a claim that all upstream projects are currently at their latest release.
