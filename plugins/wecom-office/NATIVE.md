# Independent CLI account

Keep this complete target directory, including `.neuxbot/` and `setup.mjs`. Install or register it using your CLI’s supported mechanism, then authorize and launch the same native profile:

```sh
node setup.mjs --profile codex login
node setup.mjs --profile codex status
node setup.mjs --profile codex run -- codex
node setup.mjs --profile codex logout
```

Replace `codex` with the CLI profile and real executable you use. Normal CLI load arguments follow that executable. `run` supplies verified account material; it does not install or register this package. For Feishu or WeCom, `exec -- <business arguments>` invokes the package’s private verified business CLI directly.

Account data is independent of the application: `${XDG_DATA_HOME:-~/.local/share}/neux-plugins-native/<profile>/wecom-office`. Use `--data /absolute/private/directory` before the subcommand to select another independent account boundary. Never use a host-managed account directory. Setup reuses this package’s own authorization bridge, provider lock and online verification; it needs no running Core or exported host credentials. GitHub `run` supplies the exact MCP Authorization placeholder in the child environment; it does not write OAuth tokens into package files.

Provider download and the real account flow require network access. Follow the public URL/code/QR shown by `login`. Business launch fails when authorization is missing. Native CLI/model/account acceptance must be checked on the actual target.
