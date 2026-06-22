/**
 * Build inspectctl.exe on Windows using Node SEA.
 *
 * Steps:
 *   1. Bundle TS → single CJS via esbuild (bundle/inspectctl.cjs)
 *   2. Generate the SEA blob: node --experimental-sea-config sea-config.json
 *   3. Copy current node.exe → bundle/inspectctl.exe
 *   4. Use postject to inject the blob into the new exe
 *
 * Requires Node 20+.
 *
 * Usage:
 *   node scripts/build-exe.mjs
 */
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const bundleDir = resolve(root, "bundle");

if (process.platform !== "win32") {
  console.error(
    "build-exe.mjs is for Windows. Use build-macos.mjs on macOS, build-linux.mjs on Linux."
  );
  process.exit(1);
}

if (!existsSync(bundleDir)) mkdirSync(bundleDir, { recursive: true });

// 1. Bundle.
console.log("== bundling ==");
execFileSync(process.execPath, [resolve(__dirname, "bundle.mjs")], {
  stdio: "inherit",
  cwd: root,
});

// 2. Generate SEA blob.
console.log("\n== generating SEA blob ==");
execFileSync(
  process.execPath,
  [
    "--experimental-sea-config",
    resolve(__dirname, "sea-config.json"),
  ],
  { stdio: "inherit", cwd: root }
);

// 3. Copy node.exe.
const exePath = resolve(bundleDir, "inspectctl.exe");
console.log(`\n== copying node.exe → ${exePath} ==`);
copyFileSync(process.execPath, exePath);

// 4. Inject blob with postject.
console.log("\n== injecting SEA blob with postject ==");
const blobPath = resolve(bundleDir, "sea-prep.blob");
const res = spawnSync(
  "npx",
  [
    "--yes",
    "postject",
    exePath,
    "NODE_SEA_BLOB",
    blobPath,
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ],
  { stdio: "inherit", cwd: root, shell: true }
);
if (res.status !== 0) {
  console.error("postject failed with code", res.status);
  process.exit(res.status ?? 1);
}

console.log(`\nOK: ${exePath}`);
console.log(`Test it with:  bundle\\inspectctl.exe`);
