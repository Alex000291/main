/**
 * Bundle the whole inspectctl source tree into a single CommonJS file.
 * Node SEA needs CJS (not ESM) for the embedded entry point.
 */
import { build } from "esbuild";
import { rmSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const outDir = resolve(root, "bundle");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [resolve(root, "src/index.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: resolve(outDir, "inspectctl.cjs"),
  minify: false,
  sourcemap: false,
  // Keep these as runtime deps if any native bindings appear; for now we
  // bundle everything since we only depend on pure-JS packages.
  external: [],
  banner: {
    js: "// inspectctl bundled CJS for Node SEA",
  },
  logLevel: "info",
});

console.log("bundle written to", resolve(outDir, "inspectctl.cjs"));
