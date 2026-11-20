# Figma Desktop

读取 Figma Desktop 中选定设计的布局、组件和样式。桌面服务用于查看设计。写入画布需要使用其他 Figma 集成。

## 访问要求

在运行 MCP 客户端的同一台电脑上安装并登录 Figma Desktop。桌面服务要求 Professional、Education、Organization、Government 或 Enterprise 套餐下的 Dev 或 Full 席位。

打开 Figma Design 文件，取消当前图层的选中状态，再切换到 Dev Mode。在右侧栏启用桌面 MCP 服务。Figma 在 `http://127.0.0.1:3845/mcp` 提供该服务，设计访问权限由 Figma Desktop 当前登录会话决定。

如果连接失败或列表中没有工具，请检查 Figma Desktop 是否开启，以及桌面 MCP 服务是否仍已启用。

## 使用场景

选中一个画框，询问它的组件层级、间距与样式。

详见 [Figma Desktop MCP 设置指南](https://developers.figma.com/docs/figma-mcp-server/local-server-installation/)。
