if (!process.env.BRAVE_API_KEY) {
  throw new Error("Brave Search API key is required");
}
delete process.env.BRAVE_API_KEY_FILE;
process.argv = process.argv.slice(0, 2).concat("--transport", "stdio");
const { getOptions } = await import("./config.js");
if (!getOptions()) {
  throw new Error("Brave Search MCP configuration is invalid");
}
const { default: server } = await import("./protocols/stdio.js");
await server.start();
