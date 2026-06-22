/**
 * Build inspectctl (Linux ELF binary) using Node SEA.
 * Run on Linux only.
 *
 *   node scripts/build-linux.mjs   → bundle/inspectctl (executable)
 */
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const bundleDir = resolve(root, "bundle");

if (process.platform !== "linux") {
  console.error("build-linux.mjs must be run on Linux");
  process.exit(1);
}

if (!existsSync(bundleDir)) mkdirSync(bundleDir, { recursive: true });

execFileSync(process.execPath, [resolve(__dirname, "bundle.mjs")], {
  stdio: "inherit",
  cwd: root,
});

execFileSync(
  process.execPath,
  ["--experimental-sea-config", resolve(__dirname, "sea-config.json")],
  { stdio: "inherit", cwd: root }
);

const binPath = resolve(bundleDir, "inspectctl");
copyFileSync(process.execPath, binPath);

const inject = spawnSync(
  "npx",
  [
    "--yes",
    "postject",
    binPath,
    "NODE_SEA_BLOB",
    resolve(bundleDir, "sea-prep.blob"),
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ],
  { stdio: "inherit", cwd: root, shell: true }
);
if (inject.status !== 0) process.exit(inject.status ?? 1);

execFileSync("chmod", ["+x", binPath]);

console.log(`OK: ${binPath}`);
