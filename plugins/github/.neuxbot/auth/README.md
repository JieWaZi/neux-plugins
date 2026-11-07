# GitHub 包内授权桥接

本桥接实现宿主扩展 `neuxbot-auth/1`，不属于 MCP 或 Codex 标准。标准 `mcp.json` 只声明一项官方 GitHub 服务，认证由自有桥接解释官方 GitHub CLI 设备 OAuth。stdin/stdout 是逐行 JSON-RPC 2.0，供应商原始输出不进入协议或日志。

## 声明与协议

根 `plugin.json` 的 `extensions.com.neuxbot.authentication` 声明 `plugin-command`、受信 Node、包内入口、`repo/read:org/gist` 权限以及 `preferredAction: open-url`。`bindings` 两项分别面向 codex、claude，均限定 `server: github`、URL `https://api.githubcopilot.com/mcp/`、header `Authorization`。这些是认证目标约束，不是第二份组件定义。

每个进程首先完成 `auth/initialize`，要求准确 `protocol: neuxbot-auth/1`，固定并逐字段回显 `operationId/pluginId/versionId/digest/configurationRevision/accountGeneration`；所有后续方法携带同一上下文及 `sessionId/dataDirectory/scopes`。未初始化、旧协议、重复初始化或上下文变化均拒绝。挑战和状态通知同时带有 operationId 与 sessionId。

| 方法 | 结果 |
| --- | --- |
| auth/initialize | 只固定并回显上下文，不启动供应商 |
| auth/start | 立即 `{state:"pending"}`，异步启动实际设备流 |
| auth/status | `{state,account}`，官方在线检查私有文件身份及授权范围 |
| auth/cancel | 停止并等待上游退出后返回 cancelled |
| auth/resolve | 只为获准的精确 MCP 返回私密 OAuth Bearer 头 |
| auth/logout | 停止等待并删除该插件私有 profile，返回 unauthorized；不声称远端令牌已撤销 |

挑战只包含官方 `https://github.com/login/device` 与实际一次性验证码，动作是 open-url 与 copy-code，不凭地址推测二维码。官方 CLI 不暴露到期秒数，因此十五分钟仅声明本机 `deadlineAt`，不冒充供应商 `expiresAt`。

只有登录完成、官方 `auth status --active --json hosts` 在线成功、tokenSource 精确指向本插件 hosts.yml 且 scopes 充分时，才通知 authorized。公开 account 只有 configured/available/id/name/scopes。错误只传稳定码，不带上游输出。

resolve 输入为 `components:[{componentId,key:"github",target:"mcp",url:"https://api.githubcopilot.com/mcp/"}]`。返回直接头映射：

```json
{"bindings":[{"componentId":"approved-component","headers":{"Authorization":"Bearer <private OAuth token>"}}]}
```

此结果只走宿主后端执行通道，不进入公共 API、界面或聊天。桥接只接受官方设备 OAuth 的 `gho_` 令牌，不回 PAT 配置或环境变量，也不绑定托管 apps。

## 程序与身份隔离

`assets.lock.json` 固定六平台真实程序、摘要、大小、来源、补丁和许可证据。首次按 HTTPS 下载，校验后原子写入私有 `cache/<digest>/gh[.exe]`，每次复用核对摘要和内部隔离版本。可选受信 `NEUXALLY_GH_CLI` 仅替换相同程序边界，不搜索 PATH 中用户 gh。

子进程清除 GH/GITHUB/GIT 与 KEYCHAIN/KEYRING 覆盖，HOME、XDG/Windows 配置和 GH_CONFIG_DIR 均置于宿主私有目录，PATH 只保留受管程序、受信 Node 与系统目录。登录使用 `--insecure-storage`，配置目录0700、凭据文件0600。底层隔离补丁另外把钥匙串服务绑定私有规范 profile 路径摘要，无合法目录不能访问钥匙串，避免登录迁移或库内部回退触及用户身份。

取消使用实际进程结束作为完成边界；POSIX 同时终止所属进程组，Windows 使用系统 taskkill 终止树。只允许当前会话解析自己的私密绑定。真实账号、远程 API 业务、Windows/Linux 实机以及钥匙串交互仍需独立验收；测试使用受控外部供应商边界。
