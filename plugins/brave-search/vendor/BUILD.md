# Rebuilding the Brave Search MCP bundle

The runtime artifact contains the MIT-licensed official Brave Search MCP server and its locked dependencies. The package runs the bundled file over stdio using Node.js 20 or later. The runtime does not invoke the commands below.

Check out the commit in `source-lock.json` from the recorded repository. Copy `entry.ts` to `src/neuxbot-stdio.ts` in that checkout. The entry only starts stdio and reads the key supplied to the plugin.

Install the locked dependencies for the build with `npm ci --omit=dev --ignore-scripts --no-audit --no-fund`. Run esbuild 0.28.2 from the checkout:

```sh
esbuild src/neuxbot-stdio.ts --bundle --platform=node --format=esm --target=node20 \
  --supported:template-literal=false --legal-comments=eof \
  '--banner:js=import { createRequire as requireForNode } from "node:module"; const require = requireForNode(import.meta.url);' \
  --outfile=server.mjs
```

Check the generated bundle's SHA-256 against `source-lock.json`. Keep the upstream license and the complete bundled dependency notices with the release.
