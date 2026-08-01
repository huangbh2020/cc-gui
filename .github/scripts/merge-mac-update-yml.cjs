/**
 * Merge per-arch latest-mac.yml files into one and stage all release assets.
 *
 * WHY THIS EXISTS
 * CI builds macOS arm64 and x64 as separate jobs (on matching runners, so
 * native bits - the claude binary + node-pty .node - are installed + rebuilt
 * for the correct arch). Each job emits its own latest-mac.yml, but they'd
 * clobber each other on the GitHub Release (same filename). electron-updater
 * reads a single latest-mac.yml regardless of arch (see Provider.js:
 * getChannelFilePrefix returns "-mac" for all darwin), so we merge the two
 * files arrays into one.
 *
 * The merged files array order MATTERS. electron-updater's findFile()
 * (Provider.js:74-90) picks the entry whose url includes process.arch, and
 * falls back to files[0] (shift()) if none matches. On x64 neither url
 * contains "x64" (x64 artifacts have no arch suffix), so x64 falls back to the
 * first entry. Therefore the x64 entry (url without -arm64) MUST be first,
 * matching electron-builder's own convention (writeUpdateInfoFiles sorts the
 * default-arch zip first).
 *
 * The top-level path/sha512 (backward-compat for electron-updater <2.15) are
 * taken from the x64 entry too, since x64 is the default arch and was first in
 * the original single-arch yml.
 *
 * Usage: node .github/scripts/merge-mac-update-yml.cjs <artifacts-dir> <out-dir>
 *   <artifacts-dir> has subdirs build-mac-arm64/, build-mac-x64/, build-win-x64/
 *   (from upload-artifact names). This script copies all dmg/zip/exe/blockmap/
 *   latest.yml into <out-dir>, and writes the merged latest-mac.yml there.
 *
 * Runs in the publish job on ubuntu-latest with NO node_modules installed, so
 * it uses only node: built-ins and a tiny bespoke YAML parser/serializer for
 * the fixed latest-mac.yml schema (version / files[] / path / sha512 /
 * releaseDate). No js-yaml dependency.
 */
"use strict";

const { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, copyFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const [artifactsDir, outDir] = process.argv.slice(2);
if (!artifactsDir || !outDir) {
  console.error("Usage: node merge-mac-update-yml.cjs <artifacts-dir> <out-dir>");
  process.exit(1);
}

const ARM64_DIR = "build-mac-arm64";
const X64_DIR = "build-mac-x64";
const WIN_DIR = "build-win-x64";

/**
 * Parse a latest-mac.yml (or latest.yml) into an object. Handles the schema
 * electron-builder's updateInfoBuilder emits:
 *   version: <semver>
 *   files:
 *     - url: <name>
 *       sha512: <hash>
 *       size: <num>        # optional
 *   path: <name>
 *   sha512: <hash>
 *   releaseDate: '<iso>'
 */
function parseUpdateYml(text) {
  const obj = { files: [] };
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw || raw.startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (line.startsWith("- ")) {
      // New files entry. Capture as { url, sha512, size? }.
      cur = {};
      obj.files.push(cur);
      const rest = line.slice(2);
      const m = rest.match(/^(\w+):\s*(.*)$/);
      if (m) cur[m[1]] = stripValue(m[2]);
    } else if (indent > 0 && cur) {
      // Continuation of current files entry (sha512/size under a url).
      const m = line.match(/^(\w+):\s*(.*)$/);
      if (m) cur[m[1]] = stripValue(m[2]);
    } else {
      // Top-level key. `files:` with no inline value is the block-sequence
      // header (entries follow as "- url: ..."); keep obj.files as the array
      // initialized above. Any other key gets its scalar value.
      const m = line.match(/^(\w+):\s*(.*)$/);
      if (m && m[1] !== "files") obj[m[1]] = stripValue(m[2]);
    }
  }
  return obj;
}

function stripValue(v) {
  if (v == null) return v;
  // Unquote single/double quoted scalars.
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
    return v.slice(1, -1);
  }
  return v;
}

function isArm64Entry(file) {
  // arm64 artifacts carry -arm64 in the url (e.g. Mcode-1.2.3-arm64-mac.zip);
  // x64 artifacts have no arch suffix.
  return /-arm64/i.test(file.url);
}

function serializeMergedYml(merged) {
  const lines = [];
  lines.push(`version: ${merged.version}`);
  lines.push("files:");
  for (const f of merged.files) {
    lines.push(`  - url: ${f.url}`);
    if (f.sha512) lines.push(`    sha512: ${f.sha512}`);
    if (f.size != null) lines.push(`    size: ${f.size}`);
  }
  if (merged.path) lines.push(`path: ${merged.path}`);
  if (merged.sha512) lines.push(`sha512: ${merged.sha512}`);
  if (merged.releaseDate) lines.push(`releaseDate: '${merged.releaseDate}'`);
  return lines.join("\n") + "\n";
}

function findYml(dir, name) {
  // The yml sits directly under the artifact dir (artifact root = the release/
  // glob). Walk one level to be safe in case download-artifact nested it.
  const direct = join(dir, name);
  if (existsSync(direct)) return direct;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const nested = join(dir, entry.name, name);
      if (existsSync(nested)) return nested;
    }
  }
  return null;
}

function copyAssets(dir, out, platform) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const lower = name.toLowerCase();
    // Copy installers + updater metadata. Skip latest-mac.yml here - it's
    // merged separately below.
    if (platform === "mac" && lower === "latest-mac.yml") continue;
    if (lower.endsWith(".dmg") || lower.endsWith(".zip") ||
        lower.endsWith(".exe") || lower.endsWith(".blockmap") ||
        lower === "latest.yml") {
      copyFileSync(join(dir, name), join(out, name));
      console.log(`[merge] copied ${name} from ${dir}`);
    }
  }
}

const out = resolve(outDir);
mkdirSync(out, { recursive: true });

// Stage all binary assets + latest.yml (windows) from each artifact dir.
copyAssets(join(artifactsDir, ARM64_DIR), out, "mac");
copyAssets(join(artifactsDir, X64_DIR), out, "mac");
copyAssets(join(artifactsDir, WIN_DIR), out, "win");

// Merge latest-mac.yml: arm64 + x64 entries, x64 FIRST (default arch).
const arm64YmlPath = findYml(join(artifactsDir, ARM64_DIR), "latest-mac.yml");
const x64YmlPath = findYml(join(artifactsDir, X64_DIR), "latest-mac.yml");

if (!arm64YmlPath || !x64YmlPath) {
  console.error("[merge] ERROR: missing latest-mac.yml");
  console.error(`  arm64: ${arm64YmlPath || "(not found)"}`);
  console.error(`  x64:   ${x64YmlPath || "(not found)"}`);
  process.exit(1);
}

const arm64Info = parseUpdateYml(readFileSync(arm64YmlPath, "utf8"));
const x64Info = parseUpdateYml(readFileSync(x64YmlPath, "utf8"));

if (!arm64Info.files.length || !x64Info.files.length) {
  console.error("[merge] ERROR: a latest-mac.yml has no files entries");
  console.error(`  arm64 files: ${arm64Info.files.length}`);
  console.error(`  x64 files:   ${x64Info.files.length}`);
  process.exit(1);
}

// Sanity: each arch yml should contain only its own arch entry.
for (const f of arm64Info.files) {
  if (!isArm64Entry(f)) {
    console.warn(`[merge] WARN: arm64 yml has non-arm64 entry: ${f.url}`);
  }
}
for (const f of x64Info.files) {
  if (isArm64Entry(f)) {
    console.warn(`[merge] WARN: x64 yml has arm64 entry: ${f.url}`);
  }
}

// Build merged: x64 entries first (default arch, picked by shift() fallback),
// then arm64 entries. Top-level path/sha512 come from x64 (default arch),
// matching electron-builder's own writeUpdateInfoFiles behavior.
const merged = {
  version: x64Info.version,
  files: [...x64Info.files, ...arm64Info.files],
  path: x64Info.path,
  sha512: x64Info.sha512,
  releaseDate: x64Info.releaseDate,
};

const mergedText = serializeMergedYml(merged);
const mergedPath = join(out, "latest-mac.yml");
writeFileSync(mergedPath, mergedText);
console.log(`[merge] wrote ${mergedPath}`);
console.log("[merge] merged files:");
for (const f of merged.files) {
  console.log(`    ${f.url}`);
}
