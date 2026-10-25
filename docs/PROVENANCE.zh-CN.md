# 自有插件来源规范

[English](PROVENANCE.md) | [简体中文](PROVENANCE.zh-CN.md)

每个维护包都提供同结构的 `provenance.json`，字段遵循[统一 schema](../schemas/provenance.schema.json)。它记录来源和展示证据，不代替标准插件清单，也不用于动态引用或装载其他供应商的原生插件。标准身份、内部包版本与真实组件仍在 `.codex-plugin/plugin.json`、Skills 和 MCP 文件中维护。宿主直接读取上游声明，不从插件名称、业务品牌或授权程序推断。

| 层级 | 必填内容 | 职责 |
| --- | --- | --- |
| `schemaVersion` | `1` | 当前来源结构版本 |
| `upstream` | `author`、`repository`、`license`、`distribution` | 业务能力来源；开发者、展示版本、许可与源码链接只取这里 |
| `wrapper` | `maintainer`、`repository`、`license`、英文 `changes[]` | 维护包及授权桥接的实际作者；用于维护溯源，不替代面向用户的能力署名 |
| `dependencies[]` | `name`、`repository`、固定 `commit`、`version`、`license`、包内相对 `lock` | 隔离授权或运行程序；依赖版本不能冒充业务能力版本 |
| `assets[]` | 包内相对 `path`、`sourceURL`、字节 `sha256`、`license`、`attribution` | 本地维护品牌素材；可选 `sourcePath`、`sourceSHA256` 与 `licenseURL` 保留原归档提取证据 |

`upstream` 的 `author`、`repository`、`license` 及可选 `tag`、`version`、`commit` 均为字符串。展示版本优先取 `tag`，其次取 `version`，保留 `v` 前缀。飞书开发者直接为 `Lark Suite CLI contributors`，插件展示版本直接为 `v1.0.98`，只展示这一项版本，不另列“上游版本”及内部 `0.1.0`。维护包版本和插件库 `v0.1.x` 测试发布系列继续用于内部归档、安装快照管理，不是面向用户的业务能力版本。

## 来源分发方式

- `distribution.mode: vendored-source`：经核验的源码、技能或其他业务实现复制到维护包中。必须提供完整 40 位小写提交 `commit`，有真实来源标签或版本时填写 `tag` 或 `version`。保留相对资源、原始许可并说明封装改动；目录构建及安装不再抓取上游源码。
- `distribution.mode: hosted-service`：包只通过 `distribution.url` 声明远程服务，不分发其服务实现。未固定服务端版本时不填造 `commit`、`tag` 或 `version`。GitHub 使用官方托管 MCP，辅助授权的 GitHub CLI 是单独锁定的依赖；宿主不补造缺失的业务版本。项目开源许可不等于远程服务或商标使用权。

结构示例（示意值须替换为实际核验结果）：

```json
{
  "schemaVersion": 1,
  "upstream": {
    "author": "Project contributors",
    "repository": "https://github.com/example/project",
    "license": "MIT",
    "commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "tag": "v1.2.3",
    "distribution": { "mode": "vendored-source" }
  },
  "wrapper": {
    "maintainer": "NeuxBot contributors",
    "repository": "https://github.com/JieWaZi/neux-plugins",
    "license": "MIT",
    "changes": ["Maintained standard manifest and authorization bridge"]
  },
  "dependencies": [],
  "assets": []
}
```

## 验证与更新

构建器只读取固定提交，逐包验证来源必填字段与共享 schema，核对依赖 `repository`、`commit`、`version` 与实际资产锁，并计算本地图标摘要。两个清单图标字段均须有对应素材声明。未知字段、旧 `packaging`／`capability`／`logo`／`cli` 顶层分支、源码提交缺失、非法字段、中文 `wrapper.changes`、摘要漂移与依赖锁不一致均在替换产物前失败。`scripts/provenance.mjs` 解释当前 schema 使用的基础关键字；扩充 schema 时同步扩充验证器与回归。

维护者核实品牌官网素材及使用规则后，将图标复制至包内 `assets/`，目录内嵌核验后的字节，安装前即可展示。运行时不请求图片来源，也不依赖其他供应商插件市场。复制品牌图标不代表原创，不把封装 MIT 许可套到商标上；具体来源及品牌约束写入素材记录和[第三方声明](../THIRD_PARTY_NOTICES.md)。

收录新能力时，应核实上游事实、复制所需内容、说明实际修改和许可、补齐中英文业务说明，并按通用宿主协议验证包内授权桥接。只有经过维护审核的包才能进入发布目录。修改供应商程序必须完成隔离回归及资产锁验证；修改图标或来源声明不应顺带重构建无关程序。固定版本表示核验了该来源，不代表所有上游项目当前均是最新版本。
