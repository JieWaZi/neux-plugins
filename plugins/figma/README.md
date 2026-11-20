# Figma Desktop

Read layout information, components, and styles for the design selection in Figma Desktop. The desktop service supports design inspection. Writing to the canvas requires a different Figma integration.

## Access

Figma Desktop must be installed and signed in on the same computer that runs the MCP client. Figma requires a Dev or Full seat on a Professional, Education, Organization, Government, or Enterprise plan for the desktop server.

Open a Figma Design file, deselect the current layers, and switch to Dev Mode. In the right sidebar, enable the desktop MCP server. Figma exposes it at `http://127.0.0.1:3845/mcp`. The existing Figma Desktop session controls access to designs.

If the connection fails or tools do not appear, check that Figma Desktop is open and the server is still enabled.

## Example

Select a frame and ask for a summary of its component hierarchy, spacing, and styles.

See the [Figma Desktop MCP setup guide](https://developers.figma.com/docs/figma-mcp-server/local-server-installation/).
