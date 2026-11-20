# 插件展示维护

[English](MAINTAINING.md) | [简体中文](MAINTAINING.zh-CN.md)

仓库根[开发指南](../README.zh-CN.md)负责统一标准包布局、宿主边界、授权架构和发布构建。每个插件的 README 只介绍插件自身的原生能力、权限前提与实用场景，不出现伙伴等宿主角色、NeuxBot 安装流程、聊天引导或“试着这样说”。供应商技术细节、来源版本、适配策略、验证边界和维护说明放在开发指南或[第三方声明](../THIRD_PARTY_NOTICES.md)。

## 标准清单与本地化展示

`plugins/<key>` 自有包的 `plugin.json` 默认使用英文，身份与版本只在该清单维护。设置已支持的 `extensions.com.openai.interface.displayName`、`shortDescription`、`developerName`、`logo` 和 `composerIcon`。`developerName` 使用真实业务能力品牌（GitHub / 飞书），`repository` 指向官方能力项目；封装作者与源码/许可证据分别保留，不冒充官方编写了我们的封装。图标使用包内 `./assets/` 相对路径，字段与路径约定见[官方打包文档](https://developers.openai.com/plugins/build/plugins)。

插件信息面板只读取 `provenance.upstream`：开发者取 `author`，版本先取 `tag` 再取 `version`，许可取 `license`，源码取 `repository`。飞书因此显示 `Lark Suite CLI contributors` 和 `v1.0.98`，不再分列上游版本。`manifest.version`（`0.1.x`）及清单作者继续如实标识内部维护包。GitHub 托管 MCP 没有固定服务版本，不能拿授权 CLI 版本代替。所有包统一遵循[来源规范](PROVENANCE.zh-CN.md)与 [JSON schema](../schemas/provenance.schema.json)。

`README.md` 提供英文，`README.zh-CN.md` 提供简体中文，插件说明不添加语言导航，由宿主按系统语言选择对应文档，缺少翻译时回退英文。

通过根清单 `extensions.com.neuxbot.presentation` 显式引用可选包内 `.neuxbot/presentation.json`，维护展示翻译、按索引对应的提示词翻译和静态设置帮助：

```json
{
  "displayNames": { "en": "Feishu Office", "zh-CN": "飞书办公" },
  "localizedDescriptions": {
    "en": "Write documents and follow up on tasks.",
    "zh-CN": "编写文档并跟进任务。"
  }
}
```

仅接受 `en` 与 `zh-CN`，展示文字与每条提示词最多 4 KiB UTF-8，设置说明最多 16 KiB，文件上限 1 MiB，拒绝控制字符。`defaultPromptLocalizations` 数组须与 `extensions.com.openai.interface.defaultPrompt`（字符串或字符串数组）长度和顺序一致；`setup.instructions` 为语言映射，`setup.helpURL` 为公开 HTTPS 链接。此文件不声明身份、组件或可执行行为，中英文业务含义对应。

OpenAI interface 还支持真实 `category`、`capabilities`、`supportURL`、`defaultPrompt` 与 `brandColor` / `brandColorDark`（十六进制颜色字符串）。`logo` / `logoDark` 与 `composerIcon` / `composerIconDark` 均为独立路径字符串，仅在有真实审核资产时提供暗色版本。这些资料进入详情，目录索引仅投射获准的列表摘要。

## 安装前目录图标与完整包

发布构建从该文件派生可选目录字段 `displayNames`、`localizedDescriptions`，从标准清单 `extensions.com.openai.interface.logo` 派生 `icon`，没有 logo 时取 composerIcon。目录身份仍为 `key`/`name`，默认 description 为英文。这些展示字段不改变 `schemaVersion: 1` 和安装路径。

发布图标采用 `./assets/` 下的静态非交错 8 位 PNG，不超过 256 KiB、2048×2048 像素。构建器验证签名、块校验和、尺寸、解压像素和逐行过滤器，随后生成规范 `data:image/png;base64,...`。拒绝外部 URL、越界路径、符号链接、SVG、损坏及超限数据。宿主显示目录前还会验证图标；宿主支持更多图片格式不意味着发布构建放宽规则。

目录发布安全内嵌 `icons: {default,dark}` 明暗资产，`icon` 为默认主题的派生别名。GitHub 使用同一已记录官方品牌资源包中的黑、白留白 PNG，均未改色。

目录发现不下载完整包，也不请求外部图标。完整 ZIP 保留 PNG、本地化文件与两种 README，所有内容来自固定提交，工作区未提交文件不影响发布。在审核并提交后，运行 `npm test` 和 `node scripts/build-catalog.mjs HEAD v0.1.0` 重建并验证。

## 现有集成维护

GitHub 包内只有一份标准 `mcp.json` 官方端点声明及自有设备 OAuth 桥接。各目标共享同一组件授权，只有真实差异才显式指定 runtime。包内不包含 PAT 凭据、托管 app 声明、原生来源引用或上游 HTTP 还原流程。宿主将同一份定义适配到支持的目标格式。

飞书办公保留完整官方技能与相对资料。包内桥接负责多阶段授权挑战、账号和范围核验、获准组件私密绑定；宿主管理账号、会话生命周期与秘密存储。业务执行不能通过聊天发起 CLI 登录或配置命令绕过该生命周期。隔离 CLI 及供应商版本独立记录于[资产锁](../plugins/feishu-office/.neuxbot/auth/assets.lock.json)和[桥接指南](../plugins/feishu-office/.neuxbot/auth/README.md)，不等同自有插件版本。

发布、CLI 清单校验与自动化测试不代表真实账号、平台、原生运行或界面验收。相关边界记录于实施或发布报告，插件业务 README 不插入内部验收免责声明。品牌来源与真实许可缺口保留在第三方声明中。

## 收录与系统安装边界

进入本库的插件必须由维护者完成标准包封装、授权声明、双语业务内容、图标及许可来源验证。复用上游代码不等于无审查转发任意第三方插件。NeuxBot 只接受目录中经摘要核验的发布条目，不提供用户上传或导入入口，也不在聊天中暴露系统插件安装操作。

NeuxBot 管理插件配置与共享账号。包内授权桥接通过宿主协议交付获准的组件绑定，宿主负责所选智能体的运行时交付。

## 只读详情

构建器从真实 README、SKILL 和公开元数据派生[资料侧车](DETAILS.zh-CN.md)。源说明必须是公开内容，不能含真实凭据；执行配置保留在完整 ZIP。查看详情不需要伙伴安装或授权。新目录只声明资料 URL、摘要及精确字节数，不把正文塞进索引。

## 授权挑战提示

阶段性警告文案保存在包内声明，由桥接在对应步骤通过 `auth/challenge.notice.messages` 发出；宿主通用选择语言并随当前挑战清理，不增加供应商分支。见[提示协议与 schema](AUTH-CHALLENGE-NOTICES.zh-CN.md)。不要把临时提示塞进插件简介或账号记录。

## 统一包发布

每个插件维护独立版本，发布统一 ZIP、公开详情和单条目录。NeuxBot 管理安装与账号，并完成所选智能体的运行时适配。构建、发布与重试流程见[发布指南](RELEASING.md)。
