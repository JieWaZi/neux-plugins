# Native CLI delivery

One portable package owns its Skills, MCP and authorization declaration. `server/cmd/pluginpack` in the NeuxBot repository generates CLI artifacts from that same package. This repository does not maintain ten converters or compile its catalog or documentation into the host.

`extensions.com.neuxbot.authentication.bindings` binds exact MCP server/URL/header components. `skillBindings` binds real Skill paths and approved environment keys. Omitting `runtime` shares that exact binding across all supported targets; an explicit `runtime` is reserved for an actual target difference. Schema and authentication protocol remain `1` and `neuxbot-auth/1`.

## Build a fixed release snapshot

```sh
npm ci
node scripts/sync-standalone.mjs
# Review and commit the source before building a release snapshot.
NEUX_PLUGIN_PACKAGER=/absolute/path/to/pluginpack \
  node scripts/build-release.mjs HEAD v0.1.3-dev /absolute/path/to/output
```

The shared tool can be built in the NeuxBot repository with `go build -o /absolute/path/to/pluginpack ./cmd/pluginpack` from `server/`. It takes `--source`, `--output`, `--profile all`, and `--source-id`; no target conversion is implemented in the Node release wrapper. `NEUX_PLUGIN_PACKAGER` is an explicit development override, recorded with the executable's actual SHA256 in `release.json`.

`scripts/packager.lock.json` is the sole configuration for the formal generator version and platform download URL, size and SHA256. No formal packager binary has been published or pinned yet; its `assets` map is intentionally empty, so a build without the explicit development override fails. Maintainers must publish verified tool binaries and fill that lock before claiming a formal release is reproducible by download. Never substitute an unverified latest URL.

Feishu and GitHub provider programs and notices are carried by the current `v0.1.3` release; no deleted historical release is required. To relocate already verified provider builds, run `npm run prepare:providers -- --assets /absolute/verified/providers --tag v0.1.3`. The command verifies all programs and notices against the existing locks before regenerating either lock's download URLs; provider versions, hashes, sizes and upstream provenance stay fixed. Commit those generated bindings before building the portable snapshot, and upload all provider files to that same release before publishing its catalog.

The build validates and archives a Git commit, ignores dirty files, invokes the same Go generator for every package, verifies all ten receipts and archive hashes, then replaces the output. A failure preserves the last completed output.

```text
output/
  catalog.json                   # List metadata and fixed download bindings only
  github.zip                     # Portable original, also feishu-office/wecom-office
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
