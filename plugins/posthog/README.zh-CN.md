# PostHog

探索 PostHog 产品事件、检查功能开关并查询分析数据。此插件连接由 PostHog 托管的 MCP 服务。

## 连接方式

连接需要 PostHog 个人 API Key。密钥的项目与权限须覆盖实际查询范围。

个人 API Key 通常以 `phx_` 开头。例如，查看功能开关需要授予功能开关的读取权限。

[服务商配置指南](https://github.com/PostHog/posthog/tree/master/services/mcp#quick-start)

## 使用示例

> 列出我的 PostHog 项目中的功能开关，并指出哪些处于启用状态。
