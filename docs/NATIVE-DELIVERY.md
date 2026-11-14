# Native CLI delivery

One portable package owns its Skills, MCP and authorization declaration. `server/cmd/pluginpack` in the NeuxBot repository generates CLI artifacts from that same package. This repository does not maintain ten converters or compile its catalog or documentation into the host.

`extensions.com.neuxbot.authentication.bindings` binds exact MCP server/URL/header components. `skillBindings` binds real Skill paths and approved environment keys. Omitting `runtime` shares that exact binding across all supported targets; an explicit `runtime` is reserved for an actual target difference. Schema and authentication protocol remain `1` and `neuxbot-auth/1`.

## Build a fixed snapshot

```sh
npm ci
node scripts/sync-standalone.mjs
# Review and commit the source before building a release snapshot.
node scripts/build-release.mjs HEAD github@0.1.2 /absolute/path/to/output
```

Use a tag matching the committed manifest version. To build all plugins locally, pass a development tag such as `v0.1.3-dev`. The wrapper validates the committed portable packages, runs the shared Go generator, and checks all ten target ZIPs and their receipts before replacing the output.

`scripts/packager.lock.json` records the generator version. The build uses a platform binary when the lock specifies its fixed URL, size, and SHA-256. The current lock builds `server/cmd/pluginpack` from a clean checkout of the pinned NeuxBot commit with the exact Go toolchain. That checkout binds the generator version for this source pin because its target receipt predates the `generatorVersion` field. `release.json` records the tool source or binary URL and the executable's actual SHA-256.

Build the shared tool from NeuxBot's `server/` directory with `go build -o /absolute/path/to/pluginpack ./cmd/pluginpack` to try local generator changes. Pass `NEUX_PLUGIN_PACKAGER=/absolute/path/to/pluginpack` to the build script. The resulting `release.json` marks the development override and records its digest. The publishing job rejects development overrides.

```text
output/
  catalog.json                   # Single-entry catalog for the selected plugin
  github.zip                     # Portable original
  github.details.json            # Independent digest-bound README and SKILL text
  release.json                   # Source commit, portable hashes, tool hash, target receipts
  targets/
    github/
      artifacts.json             # Source ID/digest, generator version, target hashes
      github-codex/              # Self-contained CLI package including setup and auth code
      github-codex.zip
      ...                        # claude, cursor, workbuddy, qoder, kimi, gemini, grok, opencode, pi
```

Each target ZIP is directly distributable. Preserve the complete extracted target root, including dot directories, resources, licenses, `setup.mjs` and `NATIVE.md`; copying only Skills loses its verified provider boundary. Registration and loading follow the target CLI's supported native mechanism or equivalent Skill/MCP route. A Skill/MCP-only OpenCode artifact contains no empty JS extension. Generated format validity is separate from real CLI/model/account acceptance.

## Publish a plugin and promote the catalog

### Repository settings

Set `main` as the default branch and protect it with required pull request review. Block force pushes and deletion. The workflow checks that protection applies to the dispatch ref. The repository owner configures and enforces the review and branch rules in GitHub. [Protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)

Grant upstream repository write access only to trusted maintainers authorized to manage releases. Contributors can work through forks and reviewed pull requests. GitHub grants release management to repository writers, and they can also change the permissions requested by their workflows. A read-only default for `GITHUB_TOKEN` does not change those permissions. [Release access](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases) · [Actions token permissions](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository#setting-the-permissions-of-the-github_token-permissions-for-your-repository)

Protect plugin tag names matching `*@*` with active tag rulesets. Restrict creation to release maintainers and block updates and deletions, including before a release becomes public. Use separate rulesets if maintainers need a bypass for creation. Enable GitHub immutable releases to lock new published tags and assets. The existing `v0.1.3` release and its provider assets need to remain available. [Tag rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets) · [Immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)

### Run the release

Bump the affected plugin's `plugins/<key>/plugin.json` to a new stable SemVer. Merge the change to `main`, then push a tag such as `github@0.1.2` pointing to that commit. The tag key and version must match the committed manifest. Any package affected by a shared input change needs its own version bump and tag.

After the workflow is on protected `main`, a release maintainer dispatches it from that branch with the existing tag as input.

```sh
gh workflow run release-plugin.yml --repo JieWaZi/neux-plugins --ref main -f tag='github@0.1.2'
```

The dispatch commit supplies the workflow, build scripts, dependency locks and publisher for every job. The plugin tag supplies the Git tree for the selected package. Jobs fetch `origin/main` and resolve the full tag ref to a commit on that history. The build has read access, and only the publish and catalog jobs request write access. Those jobs also check the live tag binding through GitHub. [Manual dispatch](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow) · [Workflow dispatch event](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch)

The workflow checks the current catalog for same-version binding conflicts before creating a plugin draft. It uploads the portable ZIP, details JSON, ten target ZIPs, `release.json`, the target receipt as `artifacts.json`, and the single-entry catalog as `entry.json`. It verifies the assets before publishing the plugin release with `make_latest: false`. It then streams and verifies each public fixed-tag download, retrying a failed asset individually.

The catalog job waits in the repository's shared promotion queue. It asks the GitHub Release API which release is Latest and reads `catalog.json` from that fixed tag. The first promotion uses the published `v0.1.3` catalog. The job retains the other entries with their existing download bindings, uploads the complete schema-version-1 catalog to a `catalog-<run-id>-<run-attempt>` draft, and publishes it as Latest in one API update. It verifies the result through the Release API and the client's [stable catalog URL](https://github.com/JieWaZi/neux-plugins/releases/latest/download/catalog.json).

Re-run failed workflow jobs after a transient upload, publication, or read failure. The workflow verifies the existing plugin tag and asset digests, resumes an incomplete draft, and removes only empty upload placeholders left by a failed request. When the publish response is lost, it reads the same release by ID before continuing. The catalog job reads the actual Latest again on every attempt. An equal version with matching bindings is already current. A higher catalog version stays current, and an older tag can only resume an existing draft or release. An equal version with different bindings stops publication or promotion. If a published asset conflicts, keep that release and choose a new plugin version after resolving the discrepancy.

## Publish provider dependencies

Keep the existing Feishu and GitHub provider programs and notices on `v0.1.3` for every plugin snapshot that refers to them. To relocate verified provider bytes, use `npm run prepare:providers -- --assets /absolute/verified/providers --tag <new-fixed-provider-tag>` with a new `vX.Y.Z`-style tag. The command checks all programs and notices before regenerating either lock's URLs. Publish and verify the assets at the new fixed tag with `make_latest: false`, then commit the updated bindings and release the affected plugins. Keep the provider version, size, digest, and upstream provenance when moving identical bytes.

## Independent authentication and launcher

Each extracted package has a standalone `setup.mjs`, generated from `scripts/templates/setup.mjs`. Regenerate it with `npm run generate:standalone`; do not hand-edit the three generated copies. The helper launches that same package's existing `.neuxbot/auth/authorize.mjs`. Provider integrity checks, isolated profiles, actual login verification, exact component resolution and logout remain owned by that implementation.

From the installed target root:

```sh
node setup.mjs --profile codex login
node setup.mjs --profile codex status
node setup.mjs --profile codex run -- codex
node setup.mjs --profile codex logout
```

Use the actual CLI profile (`codex`, `claude`, `cursor`, `workbuddy`, `qoder`, `kimi`, `gemini`, `grok`, `opencode` or `pi`) consistently. `run --` accepts the actual executable followed by its normal arguments, without shell evaluation; install or register the target according to that CLI before launching it. For example, a supported per-session plugin directory argument belongs after `codex` or `claude`, according to its own command syntax. This helper authenticates and launches the CLI; it does not claim to install or register a plugin. For the generated OpenCode artifact, `--profile opencode run -- opencode` validates its real `opencode.json` against the package’s declared components and writes a temporary merged Skill/MCP config under its private data directory. It selects that config through `OPENCODE_CONFIG`, binds package/data paths per target, and clears a competing inline config override. OpenCode uses that equivalent Skill/MCP config rather than an empty JS plugin. Pi MCP artifacts include a real package-declared extension calling `registerMcpServer`; it expands authorized environment placeholders at runtime, while pure Skill artifacts do not create extensions.

Native account data defaults to `${XDG_DATA_HOME:-~/.local/share}/neux-plugins-native/<profile>/<plugin>`. `--data /absolute/private/directory` explicitly selects another independent native account directory. Never point it at a host-managed account directory. Independent mode does not contact Core, read host credential files, or export host accounts. Authorization prints only the vendor bridge's public URL/code/QR challenge actions. Real account authorization remains interactive.

Feishu and WeCom `run` prepare a private business launcher on the CLI's inherited PATH. Their business Skill commands therefore keep using `lark-cli` and `wecom-cli`. For a single business call:

```sh
node setup.mjs --profile codex exec -- --help
```

`exec --` invokes the package's verified business CLI with exact arguments and the verified native account. It fails before launching business code if authorization is missing. Do not install a global vendor CLI or copy credential files.

GitHub's single exact MCP endpoint is `https://api.githubcopilot.com/mcp/`. Its public MCP declaration contains `Authorization: ${GITHUB_PLUGIN_AUTHORIZATION}`. The standalone `run` resolves only that component through the existing device-OAuth bridge and supplies the verified Bearer header through the child process environment. It never writes the token into an artifact, registry or shell command. The host resolves the same declared component through its own private account channel. Running a CLI outside the helper does not provide this native account material.

Multiple independent packages can be composed by nesting their `run -- node /path/to/next/setup.mjs --profile ... run -- ...` invocations. Each retains its own provider directory; all must have been authorized in that native profile. For OpenCode, every layer must use `--profile opencode`. The chain retains only explicitly passed target roots and revalidates each target’s manifest/config hashes, actual Skill paths and canonical HTTP MCP endpoints/headers. It uses only the current OpenCode V2 `mcp.servers` shape, without the old `enabled` field or a flat-map compatibility branch. It merges their Skill paths and MCP entries, rejects duplicate Skill names or MCP keys from different packages, and ignores an unrelated inherited `OPENCODE_CONFIG`. The merged file contains public placeholders rather than tokens and is deleted only after the actual child CLI exits. For example, after authorizing all three native profiles:

```sh
node /installed/github-opencode/setup.mjs --profile opencode run -- \
  node /installed/feishu-office-opencode/setup.mjs --profile opencode run -- \
  node /installed/wecom-office-opencode/setup.mjs --profile opencode run -- opencode
```

The outer setup waits for the actual child CLI’s exit and propagates its status. On Windows, standard npm `.cmd` shims are resolved to the exact JavaScript entry declared by their installed `package.json.bin`, then executed with Node and the original argument array. Arbitrary batch scripts are rejected; no command shell is enabled. Native `.exe` commands continue to run directly. Native Windows process behavior still requires acceptance on Windows.
