# 标准包、目录与公开资料

[English](DETAILS.md) | [简体中文](DETAILS.zh-CN.md)

每个逻辑包由根 `plugin.json`、固定 `skills/` 和 `mcp.json` 保存唯一 portable 身份与组件定义。根清单声明 Agent Plugins 1.0.0；OpenAI 展示来自 `extensions.com.openai.interface`，宿主扩展来自 `extensions.com.neuxbot`（schemaVersion 1）。共享 Go 生成器核对已登记的原生薄声明与同一组件定义是否一致，并补齐缺失入口；原生来源引用加载器与旧命名空间仍被拒绝。当前三个维护源包保持 portable，各 CLI 清单属于生成工件，工具和独立 setup 契约见[原生交付指南](NATIVE-DELIVERY.md)。

发布前使用 `npm ci` 恢复精确锁版的 AJV、ajv-formats 与 YAML 解析器。`schemas/schema-lock.json` 固定所有本地 Schema 的 SHA-256；校验不下载可变 Schema。官方 MCP 1.0.0 Schema 尚不含服务级 OpenAI 扩展，因此分别验证剥离该命名空间后的标准核心及本地 OpenAI 目标 profile，保留官方字节不改。profile 不是另一套官方标准。

| 产物 | 当前版本及内容 |
| --- | --- |
| catalog.json | schemaVersion 1；安全身份、分类、本地化、默认图标、来源提交、归档和必需的公开资料引用 |
| key.details.json | schemaVersion 1；绑定同一 sourceCommit、archiveSHA256、packagePath 的公开展示及原始 README／SKILL.md |
| key.zip | 完整 portable 源包、资源、授权程序、许可、来源与执行位 |
| targets/key/key-CLI.zip | 自包含 CLI 派生目标、setup／launcher 与许可；artifacts.json 绑定来源身份／摘要、配置档、目标和归档摘要 |

轻目录不携带 README、Skill 正文、MCP 命令／请求头或授权入口，索引发布与查询独立于详情和 ZIP 是否可用。资料最大 4 MiB，每份 README／SKILL.md 最大 1 MiB；全部摘要和大小均按最终 UTF-8 字节计算。详情缺失或损坏只使该项详情明确失败，不下载 ZIP 补详情。ZIP 的后台预取或安装准备分别按固定绑定下载并完整校验。

公开 Package 的 contractVersion 为 `neuxbot-plugin/1`，format 为 `agent-plugins`。manifest 仅公开标准身份和作者资料；presentation 包含归一为数组的 defaultPrompt、等长的 defaultPromptLocalizations、能力描述、支持链接、默认／暗色品牌色和分别校验的内嵌图标，以及静态 setup.instructions／helpURL。不存在的资料保持缺省，不伪造另一主题资产或业务版本。技能只发现固定 skills 下的直接子目录，不维护第二份组件清单。

公开 MCP 仅含组件键、传输、移除用户信息／查询／片段的 URL 及安全的标准认证说明。integration.authentication 仅包含 strategy、protocol、preferredAction、scopes。程序入口、argv、环境、请求头、秘密绑定、配置值和凭据不得进入公开资料。README 与 SKILL.md 本身也必须经过公开内容审核。

标准 MCP `none` 和通过显式配置或包内账号驱动绑定的 `api_key` 由当前宿主目标支持。`oauth`、`mixed` 与阶段二 management 声明明确拒绝，不降级匿名。`com.neuxbot` 的配置使用 fields／bindings；账号驱动使用 `neuxbot-auth/1` 的固定上下文初始化。技能账号材料还须匹配 skillBindings 的环境和私有路径允许键，不能扩大组件范围。

构建器只读取指定 Git 提交的对象。验收未提交改动时，应复制到独立临时 Git 仓库并仅在该临时仓库提交，再调用 buildCatalog；不得把工作区内容混入已有提交的发布产物。产物联验不等于上传 Release，也不授权提交或发布真实仓库。

`node scripts/build-review-snapshot.mjs` 将开发快照构建到 `.cache/development/catalog`；`--out` 可选择 `.cache` 下的其他目录。它排除已有缓存，不修改真实 Git 索引，使用可重现的合成提交，构建后清理临时源码。生成目录仍声明发布下载地址，供宿主明确选择的本地开发启动器提供工件服务并重写下载地址；不能把合成开发快照作为正式 Release 发布。正式构建继续使用真实仓库已审查的提交。
