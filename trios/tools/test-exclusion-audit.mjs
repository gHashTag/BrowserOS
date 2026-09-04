#!/usr/bin/env node
// Keeps the TriOSKitTests exclusion list honest (gHashTag/trios#1089): SwiftPM
// skips an `exclude:`d test file and only warns when it is gone, so drift
// reads as green CI. Usage: node trios/tools/test-exclusion-audit.mjs [Package.swift]
//   FR-001  parse `exclude:` from Package.swift with a line scan; no `swift`
//   FR-002  list the test target's directory with the file system
//   FR-003  print three counts: compiled, excluded, stale-excluded
//   FR-004  exit non-zero, naming every stale-excluded entry

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SKIP_DIRS = [".git", ".build", "node_modules"];
const defaultRoot = () => resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
// Strip `//` comments first: a commented-out entry is not an entry.
const noComments = (text) => text.replace(/\/\/.*$/gm, "");

// The `.testTarget(...)` block, "" when the manifest declares none; string
// literals are stepped over so a paren inside one cannot close the block.
function testTargetBlock(text) {
  const start = text.indexOf(".testTarget(");
  if (start < 0) return "";
  let depth = 0;
  for (let i = text.indexOf("(", start); i < text.length; i++) {
    if (text[i] === '"') { const end = text.indexOf('"', i + 1); if (end < 0) break; i = end; }
    else if (text[i] === "(") depth += 1;
    else if (text[i] === ")" && --depth === 0) return text.slice(start, i + 1);
  }
  return text.slice(start);
}

// Every quoted string inside a `key: [ ... ]` array of the block.
const quotedList = (block, key) => [...(block.match(new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`))?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((x) => x[1]);

// Entries named in `exclude:` whose file is not among the listed .swift files.
// An entry matches by exact (relative) name or by basename.
export function staleExclusions(excludeEntries, swiftFiles) {
  const onDisk = new Set([...swiftFiles, ...swiftFiles.map((f) => basename(f))]);
  return excludeEntries.filter((e) => !onDisk.has(e) && !onDisk.has(basename(e)));
}

// Every .swift file under the test directory, as slash-relative paths, so a
// subdirectory file is still counted - compiled or excluded, never lost.
function swiftFiles(dir, prefix = "") {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith(".swift")) out.push(prefix + e.name);
    else if (e.isDirectory() && !SKIP_DIRS.includes(e.name)) out.push(...swiftFiles(join(dir, e.name), `${prefix}${e.name}/`));
  }
  return out;
}

// Manifest candidates: this tree's root layout and the issue's
// apps/trios-macos layout first, then anything shallow enough to be a package.
function findManifest(root) {
  const fixed = [join(root, "Package.swift"), join(root, "apps", "trios-macos", "Package.swift")];
  const found = [];
  const scan = (dir, depth) => {
    if (depth > 3) return;
    for (const e of readdirSync(dir, { withFileTypes: true }))
      if (!e.isDirectory()) { if (e.name === "Package.swift") found.push(join(dir, e.name)); }
      else if (!SKIP_DIRS.includes(e.name)) scan(join(dir, e.name), depth + 1);
  };
  if (existsSync(root)) scan(root, 0);
  return [...fixed, ...found.filter((p) => !fixed.includes(p))]
    .find((p) => existsSync(p) && testTargetBlock(noComments(readFileSync(p, "utf8")))) ?? null;
}

export function audit(manifest = findManifest(defaultRoot())) {
  if (!manifest) throw new Error(`no Package.swift declaring .testTarget( under ${defaultRoot()}`);
  const block = testTargetBlock(noComments(readFileSync(manifest, "utf8")));
  const target = block.match(/name:\s*"([^"]+)"/)?.[1] ?? "tests";
  const relDir = block.match(/path:\s*"([^"]+)"/)?.[1] ?? join("Tests", target);
  const dir = resolve(dirname(manifest), relDir);
  if (!existsSync(dir)) throw new Error(`test directory not found: ${dir}`);
  const files = swiftFiles(dir);
  const entries = quotedList(block, "exclude");
  // A file is excluded when some entry matches it: it is not "stale" relative
  // to the entry list, so staleExclusions([file], entries) comes back empty.
  const excluded = files.filter((f) => staleExclusions([f], entries).length === 0).length;
  return { manifest, target, dir, total: files.length,
    compiled: files.length - excluded, excluded, stale: staleExclusions(entries, files) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const r = audit(process.argv[2] ? resolve(process.argv[2]) : undefined);
    console.log(`manifest: ${r.manifest} (${r.target} at ${r.dir})`);
    console.log(`compiled: ${r.compiled}`);
    console.log(`excluded: ${r.excluded}`);
    console.log(`stale-excluded: ${r.stale.length}`);
    for (const s of r.stale) console.log(`  stale entry: ${s}`);
    process.exitCode = r.stale.length ? 1 : 0;
  } catch (err) {
    console.error(String(err.message ?? err));
    process.exitCode = 2;
  }
}
