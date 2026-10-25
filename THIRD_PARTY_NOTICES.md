# 第三方来源与许可

本仓库根 MIT 许可只覆盖 NeuxBot 自行编写的标准包封装、桥接与构建材料，不改变官方技能、CLI 依赖或商标的作者及许可。我们自行维护完整 OpenAI/Codex 标准包，官方开源项目与示例仅作为能力来源或封装参考，不维护两套原生来源引用。业务信息直接读取统一 `provenance.upstream`，本仓库实际封装者记录于 `wrapper`，不冒充官方发布。

## GitHub MCP 与自有封装

- 业务服务：[github/github-mcp-server](https://github.com/github/github-mcp-server)，官方托管地址 `https://api.githubcopilot.com/mcp/`。本包只声明远程 MCP 地址，不分发其服务实现，也不虚构服务端固定版本。
- `plugins/github` 的标准清单、MCP 配置和声明驱动 OAuth 桥接由 NeuxBot contributors 维护，根 MIT 许可适用这些自编材料。设备流解释复用本项目既有应用授权实现的算法；不是 GitHub 官方发布的插件封装。
- 元数据 `developerName: GitHub` 与 repository 指向业务能力的实际品牌与官方项目；清单 author 与 `provenance.wrapper` 如实记录实际封装者，`provenance.upstream.author: GitHub` 记录能力来源；项目 MIT 许可不等于托管服务或商标使用许可。

## GitHub CLI 隔离依赖

- 上游：[cli/cli](https://github.com/cli/cli/tree/fc4b137cdef0a6bd28fd461b7cf9c84a5812a8cd)，固定提交 `fc4b137cdef0a6bd28fd461b7cf9c84a5812a8cd`，原版本 `2.102.0`。
- 隔离构建 `2.102.0-neuxally.2`，不是未修改的官方发行二进制。源码归档、固定 Go 工具链、六平台资产、大小/摘要和补丁证据记录在 [资产锁](plugins/github/.neuxally/auth/assets.lock.json)。
- [原始 MIT 许可](patches/LICENSE.github-cli) 保留上游版权。[公开补丁](patches/github-keyring-isolation.patch) 将底层 Set/Get/Delete 服务绑定已存在的私有 GH_CONFIG_DIR 规范路径 SHA-256；没有合法目录时拒绝钥匙串访问，覆盖登录迁移和退出路径。[回归](patches/github-keyring-isolation_test.go) 走上游内存钥匙串，不访问测试机器真实存储。
- 完整第三方依赖与 Go runtime 许可原文收集于 [CLI 声明](plugins/github/.neuxally/auth/THIRD_PARTY_NOTICES.cli.txt)，同文作为独立 Release 资产交付。部分模块没有独立 LICENSE 时保留实际可得的原始说明并披露缺口，不补造许可。
- [固定构建来源记录](patches/github-cli-provenance.json)。二进制只作为发布依赖资产，运行时按摘要下载至插件私有目录，不使用用户全局 gh 或全局身份。

## 飞书技能与 Lark CLI

- 上游：[larksuite/cli](https://github.com/larksuite/cli/tree/ac81f5056ab88f37d581d25916f3dab85abfca76)，提交 `ac81f5056ab88f37d581d25916f3dab85abfca76`，原版本 `1.0.98`。
- 原作者 Lark Suite CLI contributors，源码版权包含 Lark Technologies Pte. Ltd.；[原始 MIT 许可](plugins/feishu-office/LICENSE.larksuite-cli)完整保留。官方 skills、相对资料与脚本保持原样。
- NeuxBot contributors 维护自有标准清单、私有授权桥接与包装，业务标题为飞书办公，信息面板直接显示上游作者 `Lark Suite CLI contributors` 与版本 `v1.0.98`，实际来源及改动见 [provenance](plugins/feishu-office/provenance.json)。
- 既有隔离 CLI 构建 `1.0.98-neuxbot.1` 保持不变；固定依赖与源码/补丁摘要见 [资产锁](plugins/feishu-office/.neuxally/auth/assets.lock.json)。[钥匙串补丁](patches/lark-keychain-isolation.patch)、[隔离回归](patches/lark-keychain-isolation_test.go)与 [macOS 私有存储回归](patches/lark-storage-isolation_darwin_test.go)如实交付。
- 实际传递依赖与 runtime 原始许可见 [CLI 声明](plugins/feishu-office/.neuxally/auth/THIRD_PARTY_NOTICES.cli.txt)，同文另作为 Release 资源。新增 GitHub 依赖不重构建或替换这些既有资产。

## 品牌图标

- `plugins/github/assets/icon.png` 原样提取自 [GitHub 官方品牌资源包](https://brand.github.com/GitHub_Logos.zip) 的 `GitHub Logos/PNG/GitHub_Invertocat_Black_Clearspace.png`，原 ZIP SHA-256 `e2a67d6cc51d990a52c46c1cf6bcab688db4830982174bca50e0be7a5c2f3194`，PNG SHA-256 `581c35d9f3c3a10bba201f63a43ac59173e7b89b0bd2ff9070179205e2ffc26f`，384×384 透明 PNG，未修改图形。素材本地维护，只用于识别 GitHub 集成；实际权利人是 GitHub, Inc.，遵循[官方品牌规则](https://brand.github.com/foundations/logo)，不将源码或封装 MIT 许可套用于图标，不声称 GitHub 背书。当前包不再使用其他插件仓库的图标副本。
- `plugins/feishu-office/assets/icon.png` 原样复用应用提交 `7d4f24e6d23db28a3cbd6e488a09a20498709ee1` 的 `desktop/src/shared/assets/brands/feishu.png`，SHA-256 `a8b56475a902623937409d0fdc68b4b91040aa6ce34cd71e7870acf0cc8a62d9`。应用同目录来源记录追溯到[飞书官网](https://www.feishu.cn/) `og:image` 与[官网 CDN 资源](https://p1-hera.feishucdn.com/tos-cn-i-jbbdkfciu3/84a9f036fe2b44f99b899fff4beeb963~tplv-jbbdkfciu3-image:100:100.image)。未发现该图标的独立开源许可；不将本仓库或 CLI 的 MIT 许可套用于品牌，也不声称官方背书。

## 维护规则

保留实际来源、完整提交、原作者、许可证据和修改说明；不把独立远程服务、示例或某一依赖的许可扩大到整包。更新程序依赖时必须重跑底层隔离回归、核验固定源码并生成真实跨平台摘要。自动化与源码分发不代表真实账号、平台或宿主验收。

## WeCom CLI and skills

`plugins/wecom-office/skills/` contains the official [WecomTeam/wecom-cli](https://github.com/WecomTeam/wecom-cli) skills and relative resources at release commit `f9b28151dc8d42f703db624fc9b26723c3c93fc5` (1.3.4). Copyright (c) 2026 WeCom; MIT text is preserved in `plugins/wecom-office/LICENSE.wecom-cli`. The shared skill's installation and authorization instructions are adapted to the managed plugin lifecycle. Other upstream skill files are preserved unchanged.

The authorization bridge and asset loader are maintained by NeuxBot contributors under MIT. Official native binaries are distributed by the five `@wecom/cli-{platform}` npm packages, with independent archive SHA-256, npm SHA-512 integrity, binary size and SHA-256 recorded in the package lock. The macOS x64 binary reports version 1.3.4 and release commit f9b2815. This does not claim reproducible builds or verification of every platform's runtime behavior. No unofficial MCP service is included.

`plugins/wecom-office/assets/icon.png` is losslessly re-encoded as RGBA PNG from the application's indexed WeCom brand asset, originally obtained from the [official WeCom CDN](https://wwcdn.weixin.qq.com/node/wework/images/wecom_20.c2xok7bh.png). WeCom names and marks belong to Tencent and their respective owners. No separate open-source brand license was found; the wrapper MIT license does not cover trademark rights and does not imply official endorsement.
