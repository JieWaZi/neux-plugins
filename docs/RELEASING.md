# NeuxBot plugin releases

This repository maintains one standard package and one version per NeuxBot plugin. Each fixed plugin release publishes exactly three files.

| Release asset | Purpose |
| --- | --- |
| `<key>.zip` | Unified package with manifest, Skills, MCP, authorization bridge, licenses and provenance |
| `<key>.details.json` | Public metadata and documentation bound to the archive digest |
| `entry.json` | One catalog entry binding the version, source commit, archive and public details |

The Latest catalog release contains two files. `catalog-v2.json` lists all maintained plugins. `catalog.json` retains versions supported by earlier hosts and excludes new hosted OAuth versions. Both files use catalog schema version 1. NeuxBot downloads the fixed unified archive when needed.

## Build a fixed snapshot

```sh
npm ci
npm run build:release -- HEAD github@0.1.2 /absolute/path/to/output
```

The tag must match the selected package's committed manifest version. The builder uses Git objects, validates the standard package, provenance, dependency locks and asset hashes, and atomically replaces the output with `catalog.json`, `<key>.zip` and `<key>.details.json`. Use a separate output directory for a single-plugin build. Node 22+ and Git are the release build dependencies.

## Publish a plugin and promote the catalog

### Repository settings

Set `main` as the default branch and protect it with required pull request review. Block force pushes and deletion. The workflow checks that protection applies to the dispatch ref. The repository owner configures and enforces the review and branch rules in GitHub. [Protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)

Grant upstream repository write access only to trusted maintainers authorized to manage releases. Contributors can work through forks and reviewed pull requests. GitHub grants release management to repository writers, and they can also change the permissions requested by their workflows. A read-only default for `GITHUB_TOKEN` does not change those permissions. [Release access](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases) · [Actions token permissions](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository#setting-the-permissions-of-the-github_token-permissions-for-your-repository)

Protect plugin tag names matching `*@*` with active tag rulesets. Restrict creation to release maintainers and block updates and deletions, including before a release becomes public. Use separate rulesets if maintainers need a bypass for creation. Enable GitHub immutable releases to lock new published tags and assets. Provider assets referenced by current package locks must remain available at their fixed URLs. [Tag rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets) · [Immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)

### Run the release

Bump the affected plugin's `plugins/<key>/plugin.json` to a new stable SemVer. Merge the change to `main`, then push a tag such as `github@0.1.2` pointing to that commit. The tag key and version must match the committed manifest. Any package affected by a shared input change needs its own version bump and tag.

After the workflow is on protected `main`, a release maintainer dispatches it from that branch with the existing tag as input.

```sh
gh workflow run release-plugin.yml --repo JieWaZi/neux-plugins --ref main -f tag='github@0.1.2'
```

The dispatch commit supplies the workflow, build scripts, dependency locks and publisher for every job. The plugin tag supplies the Git tree for the selected package. Jobs fetch `origin/main` and resolve the full tag ref to a commit on that history. The build has read access, and only the publish and catalog jobs request write access. Those jobs also check the live tag binding through GitHub. [Manual dispatch](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow) · [Workflow dispatch event](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch)

The workflow verifies package details, checks both current catalogs for same-version binding conflicts, and checks the projected catalog sizes before creating a plugin draft. It uploads the unified ZIP, details JSON and single-entry catalog as `entry.json`. It verifies the assets before publishing the plugin release with `make_latest: false`. It then streams and verifies each public fixed-tag download, retrying a failed asset individually.

The catalog job waits in the repository's shared promotion queue. It reads the catalog assets from the fixed tag currently marked Latest and uses `catalog.json` as the initial full catalog if `catalog-v2.json` is absent. Each candidate's public details are verified against the fixed release digest and used to identify hosted OAuth. A hosted OAuth update goes into the full catalog and retains any earlier compatible entry in `catalog.json`.

The job uploads both complete catalog files to a single `catalog-<run-id>-<run-attempt>` draft. It compares the starting release and both asset bindings with the current Latest again before one API update promotes the draft. It then verifies the Release API and both [full](https://github.com/JieWaZi/neux-plugins/releases/latest/download/catalog-v2.json) and [compatibility](https://github.com/JieWaZi/neux-plugins/releases/latest/download/catalog.json) URLs.

Re-run failed workflow jobs after a transient upload, publication, or read failure. The workflow verifies the existing plugin tag and asset digests, resumes an incomplete draft, and removes only empty upload placeholders left by a failed request. When the publish response is lost, it reads the same release by ID before continuing. The catalog job reads the actual Latest again on every attempt. An equal version with matching bindings is already current. A higher catalog version stays current, and an older tag can only resume an existing draft or release. An equal version with different bindings stops publication or promotion. If a published asset conflicts, keep that release and choose a new plugin version after resolving the discrepancy.

## Release a batch

For a larger rollout, merge the package changes and push each fixed plugin tag first. Dispatch **Release plugin batch** from protected `main` with one tag per line, up to 25 distinct plugins. A batch still publishes each package as its own immutable release. It checks that each merged catalog fits the 4 MiB client limit before publishing fixed assets, then promotes both catalogs together once.

```sh
gh workflow run release-plugin-batch.yml --repo JieWaZi/neux-plugins --ref main -f tags="$(cat plugin-tags.txt)"
```

The single and batch workflows share separate publication and promotion queues. Wait for successful catalog promotion before dispatching the next batch. To resume, rerun the failed jobs with the same tags.

## Publish provider dependencies

Feishu and GitHub provider programs and notices are published separately under `v0.1.4-providers`, with Latest disabled. To relocate verified provider bytes, use `npm run prepare:providers -- --assets /absolute/verified/providers --tag <new-fixed-provider-tag>` with a new `vX.Y.Z`-style tag. The command checks all programs and notices before regenerating either lock's URLs. Publish and verify the assets at the new fixed tag with `make_latest: false`, then commit the updated bindings and release the affected plugins. Keep the provider version, size, digest, and upstream provenance when moving identical bytes.
