// Client bundle for the standalone app.
//
// Same Bun.build configuration the platform SDK used (entrypoint
// client/index.html -> client/dist, production mode, tailwind plugin),
// minus the platform guard and the platform-version define. Asset naming
// matches the original so relative asset URLs resolve the same way.

import { rm } from "node:fs/promises";
import { basename } from "node:path";
import tailwindPlugin from "bun-plugin-tailwind";

const ENTRY = "./client/index.html";
const OUTDIR = "./client/dist";

await rm(OUTDIR, { force: true, recursive: true });

const result = await Bun.build({
  entrypoints: [ENTRY],
  outdir: OUTDIR,
  minify: true,
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  naming: {
    asset: "assets/[name]-[hash].[ext]",
    chunk: "assets/[name]-[hash].[ext]",
    entry: "[name].[ext]",
  },
  plugins: [tailwindPlugin],
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  throw new Error("buildClient() failed; see logged diagnostics");
}

// Bun writes imported assets to `naming.asset` (`assets/<name>-<hash>.<ext>`)
// but emits the JS/CSS import URL as a bare `./<name>-<hash>.<ext>` —
// without the `assets/` directory prefix. Re-prefix only the bare
// imported-asset URLs to `./assets/...` (same fix the SDK's builder did).
const assetFiles = result.outputs
  .filter((output) => output.kind === "asset")
  .map((output) => basename(output.path));

for (const output of result.outputs) {
  if (!/\.(js|css|html)$/.test(output.path)) continue;
  let text = await output.text();
  let changed = false;
  for (const name of assetFiles) {
    const bare = `"./${name}"`;
    if (text.includes(bare)) {
      text = text.split(bare).join(`"./assets/${name}"`);
      changed = true;
    }
    const bareSingle = `'./${name}'`;
    if (text.includes(bareSingle)) {
      text = text.split(bareSingle).join(`'./assets/${name}'`);
      changed = true;
    }
  }
  if (changed) {
    await Bun.write(output.path, text);
  }
}

console.log(`client built -> ${OUTDIR}`);
