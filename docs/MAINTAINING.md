# Maintaining plugin presentation

[English](MAINTAINING.md) | [简体中文](MAINTAINING.zh-CN.md)

The repository [development guide](../README.md) owns the canonical package layout, target adapters, authorization architecture and release builds. Plugin READMEs describe only the plugin’s native capabilities, access requirements and practical uses. Do not include host roles such as partners, NeuxBot installation steps, chat prompts or “try asking” instructions. Keep vendor details, source versions, compatibility decisions, validation limits and maintenance instructions in the development guide or [third-party notices](../THIRD_PARTY_NOTICES.md).

## Standard manifest and localized presentation

Maintain each `plugins/<key>` package's `.codex-plugin/plugin.json` in English. Keep identity and version there; set the supported `interface.displayName`, `shortDescription`, `developerName`, `logo` and `composerIcon` fields. Use the actual capability brand for `developerName` (GitHub / 飞书), and the official capability project for `repository`. Preserve the packaging author and source/license evidence separately; do not claim official authorship of our wrapper. Visual paths are package-relative `./assets/` paths, as described in the [official packaging documentation](https://developers.openai.com/plugins/build/plugins).

The plugin information panel reads only `provenance.upstream`: developer from `author`, version from `tag` then `version`, license from `license`, and source from `repository`. Feishu therefore shows `Lark Suite CLI contributors` and `v1.0.98`, with no second upstream-version field. `manifest.version` (`0.1.x`) and the manifest author remain the truthful internal maintained package identity. Hosted GitHub MCP has no fixed service version; do not substitute its authorization CLI version. Both packages follow the same [provenance contract](PROVENANCE.md) and [JSON schema](../schemas/provenance.schema.json).

Use `README.md` for English and `README.zh-CN.md` for Simplified Chinese, without language-switch links. The host selects the corresponding document and falls back to English when a translation is absent.

The optional package-local `.neuxally/presentation.json` contains only translated display text:

```json
{
  "displayNames": { "en": "Feishu Office", "zh-CN": "飞书办公" },
  "localizedDescriptions": {
    "en": "Write documents and follow up on tasks.",
    "zh-CN": "编写文档并跟进任务。"
  }
}
```

Only `en` and `zh-CN` are accepted, each nonempty value is limited to 4 KiB of UTF-8, and control characters are rejected. The file is bounded to 20 KiB. It does not declare identity, components, behavior or arbitrary README paths. Keep English translations consistent with the standard manifest, and keep business meaning equivalent across languages.

## Catalog icons and complete packages

The release builder derives optional `displayNames` and `localizedDescriptions` from that file, and `icon` from the standard manifest's `interface.logo` (or `composerIcon` when logo is absent). Catalog identity remains `key`/`name`; the default description remains English. These display fields do not change `schemaVersion: 2` or install paths.

For release icons, use a static noninterlaced 8-bit PNG under `./assets/`, at most 128 KiB and 2048×2048 pixels. The builder validates the signature, chunk checksums, dimensions, compressed pixels and scanline filters before emitting a canonical `data:image/png;base64,...` URI. It rejects external URLs, unsafe paths, symlinks, SVG and malformed or oversized data. The host also validates catalog icons before presenting them; its broader supported image set does not expand the release policy.

Catalog discovery needs no package download or external icon request. The complete ZIP retains the PNG, localized presentation file and both READMEs. All are read from the fixed source commit; dirty workspace files cannot alter that release. Rebuild and verify with `npm test` and `node scripts/build-catalog.mjs HEAD v0.1.0` after committing the reviewed changes.

## Existing integrations

GitHub contains one standard `.mcp.json` entry for the official endpoint and its own device OAuth bridge. Runtime bindings identify this same component, never a second implementation. No PAT placeholders, managed app declarations, native source references or upstream HTTP materialization belong to the package. The host adapts this single definition to supported target formats.

Feishu Office keeps complete official skills and relative resources. Its package-owned bridge handles successive authorization challenges, verifies identity/scopes, and supplies approved private component bindings. The host owns account/session lifecycle and secret storage. Execution must not bypass that lifecycle with chat-issued CLI login/configuration commands. The fixed isolated CLI and provider versions are recorded in the [asset lock](../plugins/feishu-office/.neuxally/auth/assets.lock.json) and [bridge guide](../plugins/feishu-office/.neuxally/auth/README.md), independently of the own plugin version.

Publication, CLI schema validation and automated tests do not constitute real account, platform, native runtime or UI acceptance. Record those boundaries in implementation/release reports, rather than inserting internal validation disclaimers into business README content. Preserve brand attribution and actual license gaps in the third-party notices.

## Curation and system installation boundary

Before a plugin enters this library, maintainers validate its standard package, authentication declaration, bilingual business content, icon, provenance, licenses, and supported CLI targets. Reusing upstream code does not turn this library into an unchecked third-party package relay. NeuxBot accepts only published catalog entries with verified archive digests. It exposes no user upload or import path and no system-plugin installation operation to conversation agents.

Native plugin installation shares the corresponding external CLI environment and is not synchronized into this library or the application resource database. Managed plugins are attached for the session without replacing native installation state or model accounts. Custom supplier authentication is handled by maintained package bridges and the generic host protocol; third-party native authentication remains the CLI’s responsibility.

## Read-only details

The builder derives README, SKILL text and public metadata into [details sidecars](DETAILS.md). Keep source documentation public and free of live credentials; execution metadata remains in the complete ZIP. Viewing details requires no partner installation or authorization. New catalog entries advertise only the details URL, digest and exact size, without embedding documentation in the index.

## Authorization challenge notices

Keep step-specific warning text in a package-owned declaration. A bridge may attach it as `auth/challenge.notice.messages`; the host selects language and clears it with the current challenge, without provider branches. See the [notice contract and schemas](AUTH-CHALLENGE-NOTICES.md). Do not place this transient message in plugin descriptions or account records.
