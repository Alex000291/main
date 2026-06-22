/**
 * Build inspectctl (macOS Mach-O binary) using Node SEA, then wrap in .dmg.
 * Run on macOS only.
 *
 *   node scripts/build-macos.mjs           → bundle/inspectctl (binary)
 *   node scripts/build-macos.mjs --dmg     → also produces bundle/inspectctl.dmg
 *
 * Notes:
 *   - macOS requires the SEA binary to be re-signed because mach-o is parsed
 *     differently than Windows PE.
 *   - .dmg uses hdiutil (built into macOS).
 *   - Unsigned binaries will prompt the user on first run; for distribution
 *     you need an Apple Developer ID and notarization.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const bundleDir = resolve(root, "bundle");

if (process.platform !== "darwin") {
  console.error("build-macos.mjs must be run on macOS");
  process.exit(1);
}

if (!existsSync(bundleDir)) mkdirSync(bundleDir, { recursive: true });

console.log("== bundling ==");
execFileSync(process.execPath, [resolve(__dirname, "bundle.mjs")], {
  stdio: "inherit",
  cwd: root,
});

console.log("\n== generating SEA blob ==");
execFileSync(
  process.execPath,
  ["--experimental-sea-config", resolve(__dirname, "sea-config.json")],
  { stdio: "inherit", cwd: root }
);

const binPath = resolve(bundleDir, "inspectctl");
console.log(`\n== copying node → ${binPath} ==`);
copyFileSync(process.execPath, binPath);

// Remove existing signature so postject can modify the binary.
console.log("\n== removing existing signature ==");
spawnSync("codesign", ["--remove-signature", binPath], { stdio: "inherit" });

console.log("\n== injecting SEA blob with postject ==");
const blobPath = resolve(bundleDir, "sea-prep.blob");
const inject = spawnSync(
  "npx",
  [
    "--yes",
    "postject",
    binPath,
    "NODE_SEA_BLOB",
    blobPath,
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    "--macho-segment-name",
    "NODE_SEA",
  ],
  { stdio: "inherit", cwd: root, shell: true }
);
if (inject.status !== 0) process.exit(inject.status ?? 1);

console.log("\n== ad-hoc signing ==");
spawnSync("codesign", ["--sign", "-", binPath], { stdio: "inherit" });

console.log(`\nOK: ${binPath}`);

// Optional: produce .dmg.
if (process.argv.includes("--dmg")) {
  console.log("\n== building .dmg ==");
  const stagingDir = resolve(bundleDir, "dmg-staging");
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });
  copyFileSync(binPath, resolve(stagingDir, "inspectctl"));

  const dmgPath = resolve(bundleDir, "inspectctl.dmg");
  rmSync(dmgPath, { force: true });
  spawnSync(
    "hdiutil",
    [
      "create",
      "-volname",
      "inspectctl",
      "-srcfolder",
      stagingDir,
      "-ov",
      "-format",
      "UDZO",
      dmgPath,
    ],
    { stdio: "inherit" }
  );
  console.log(`OK: ${dmgPath}`);
}
