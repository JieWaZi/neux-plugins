# Standard packages, catalog and public details

[English](DETAILS.md) | [简体中文](DETAILS.zh-CN.md)

Each logical package has only root `plugin.json`, fixed `skills/` and `mcp.json`. It declares Agent Plugins 1.0.0. OpenAI presentation comes from `extensions.com.openai.interface`; the host extension is `extensions.com.neuxbot` schemaVersion 1. Codex/Claude input manifests, native source references and old namespaces are rejected.

Use `npm ci` for the exact locked AJV, ajv-formats and YAML versions. `schemas/schema-lock.json` pins every local Schema SHA-256; validation never downloads mutable schemas. The official MCP 1.0.0 Schema does not include server-level OpenAI extensions. We validate its portable core with that extension removed, then validate the separate local OpenAI target profile. Official schema bytes remain unchanged; the profile is not claimed as another official standard.

| Artifact | Current contract |
| --- | --- |
| catalog.json | schemaVersion 1: safe identity, category, localization, default icon, fixed source/archive and mandatory details references |
| key.details.json | schemaVersion 1: public presentation and exact README/SKILL.md, bound to the same sourceCommit, archiveSHA256 and packagePath |
| key.zip | Complete standard source, resources, authorization program, licenses, provenance and executable modes |

Details are limited to 4 MiB; each README/SKILL.md is limited to 1 MiB. Digests and sizes use final UTF-8 bytes. Missing or damaged details fail explicitly; reading details never falls back to downloading the installation ZIP. Installation preparation separately verifies the complete archive.

The public Package has contractVersion `neuxbot-plugin/1` and format `agent-plugins`. Its manifest contains only public identity and authorship. Presentation includes normalized defaultPrompt arrays, index-aligned defaultPromptLocalizations, capability descriptions, support links, independently validated theme icons and colors, and static setup instructions/helpURL. Missing metadata stays absent; no theme asset or business version is invented. Skills are discovered only in direct children of the fixed skills directory.

Public MCP summaries contain only keys, transport, URLs stripped of user info/query/fragment, and safe standard authentication declarations. Public integration.authentication contains only strategy, protocol, preferredAction and scopes. Driver entries, argv, environment, headers, secret bindings, configuration values and credentials never enter details. README and SKILL.md must also be reviewed as public content.

The current host supports MCP `none` and explicitly bound `api_key`. OAuth, mixed authentication and phase-two management declarations are rejected without anonymous downgrade. NeuxBot configuration uses fields/bindings. Account drivers initialize `neuxbot-auth/1` with fixed operation/content/account context. Skill materials must match declared skillBindings environment and private-path allowlists.

The builder reads only objects from a specified Git commit. To verify uncommitted changes, copy them into an independent temporary Git repository, commit only that fixture repository, then call buildCatalog. Verification artifacts do not constitute a Release upload or authorization to commit/publish the real repositories.

`node scripts/build-review-snapshot.mjs` performs that development snapshot build into `.cache/development/catalog`; `--out` can select another directory below `.cache`. It excludes existing caches, leaves the actual Git index untouched, uses a reproducible synthetic commit, and removes the temporary source after building. Its catalog still references release URLs until the host's explicit local-development launcher hosts the artifacts and rewrites those download URLs. Do not publish these synthetic development snapshots as a release; release builds continue to use an actual reviewed repository commit.
