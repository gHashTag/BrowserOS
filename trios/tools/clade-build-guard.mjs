#!/usr/bin/env node
// clade-build-guard - gate for gHashTag/trios#1356
//
// `cargo run --bin clade-build` defaults to the prod variant and writes
// {project_dir()}/trios.app - the application the user is running
// (rings/RUST-01/clade-build/src/main.rs:54, :330, :347). `resolve_variant`
// has no dev arm, so even TRIOS_VARIANT=dev builds prod. Five skills told
// agents to run the command bare; this gate keeps that class of instruction
// out of the skill directory.
//
// Rules taken from the issue:
//   FR-003  The skill directory is read from the filesystem, so a skill
//           added later is covered without editing this gate.
//   FR-004  An invocation that explicitly opts into a variant
//           (TRIOS_VARIANT=prod, TRIOS_VARIANT=staging, ...) is allowed,
//           and the opt-in must be visible on the same line as the command.
//           Silence is what this gate is about.
//   FR-005  Node standard library only. This script runs `cargo` and `make`
//           never; it only reads files.
//
// Usage:  node trios/tools/clade-build-guard.mjs
// Exit:   0 - no bare invocation found
//         1 - at least one bare invocation found (each is named file:line)
//         2 - the skill directory could not be read

import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");
const repoName = basename(repoRoot);
const skillsDir = join(repoRoot, ".claude", "skills");

// One invocation of the builder. Tolerates extra whitespace inside the
// command; the tree has never used another spelling (no --release between
// run and --bin), so the pattern stays as narrow as the hazard it names.
const INVOCATION = /cargo\s+run\s+--bin\s+clade-build/;

// A visible opt-in: TRIOS_VARIANT=<non-empty> anywhere on the same line.
// Anything else on the line (TRIOS_SKIP_CHAT_E2E=1, cd ..., pipes) is not
// an opt-in and does not clear the invocation.
const OPT_IN = /TRIOS_VARIANT\s*=\s*\S+/;

// Recursively list the regular files of the skill directory. Symlinks are
// skipped so the gate cannot be led outside the tree it guards.
function listSkillFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSkillFiles(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files.sort();
}

// Read every skill file into memory once. Unreadable files are counted, not
// silently ignored - a filter must say how much it selected.
function readSources(files) {
  const sources = [];
  let unreadable = 0;
  for (const file of files) {
    try {
      sources.push({ file, lines: readFileSync(file, "utf8").split(/\r?\n/) });
    } catch {
      unreadable += 1;
    }
  }
  return { sources, unreadable };
}

// Every line that invokes clade-build WITHOUT a visible TRIOS_VARIANT opt-in
// on that same line. This is the finding the gate exists to report.
function bareInvocations(sources) {
  const bare = [];
  for (const { file, lines } of sources) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (INVOCATION.test(line) && !OPT_IN.test(line)) {
        bare.push({ file, line: i + 1, text: line.trim() });
      }
    }
  }
  return bare;
}

function displayPath(file) {
  return `${repoName}/${relative(repoRoot, file)}`;
}

function main() {
  let files;
  try {
    files = listSkillFiles(skillsDir);
  } catch (err) {
    console.error(
      `[FAIL] clade-build-guard: cannot read ${displayPath(skillsDir)}: ${err.message}`
    );
    process.exit(2);
  }

  const { sources, unreadable } = readSources(files);
  const bare = bareInvocations(sources);

  // Totals for the summary: how many invocations exist at all, and how many
  // of them carry a visible opt-in (the allowed arm of FR-004).
  const filesWithInvocation = new Set();
  const filesWithOptIn = new Set();
  let explicit = 0;
  for (const { file, lines } of sources) {
    for (const line of lines) {
      if (INVOCATION.test(line)) {
        filesWithInvocation.add(file);
        if (OPT_IN.test(line)) {
          explicit += 1;
          filesWithOptIn.add(file);
        }
      }
    }
  }
  const filesWithBare = new Set(bare.map((f) => f.file));

  console.log(
    `clade-build-guard: scanning ${displayPath(skillsDir)} for \`cargo run --bin clade-build\` without a TRIOS_VARIANT opt-in on the same line`
  );

  for (const finding of bare) {
    console.log(
      `[FAIL] ${displayPath(finding.file)}:${finding.line}: ${finding.text}`
    );
  }

  console.log(
    `Summary: ${bare.length} bare invocation(s) in ${filesWithBare.size} file(s); ` +
      `${explicit} invocation(s) with a visible TRIOS_VARIANT opt-in in ${filesWithOptIn.size} file(s) (allowed); ` +
      `${bare.length + explicit} invocation(s) across ${filesWithInvocation.size} file(s); ` +
      `${files.length} file(s) scanned${unreadable > 0 ? `, ${unreadable} unreadable and skipped` : ""}.`
  );

  if (bare.length > 0) {
    console.log(
      `[FAIL] clade-build-guard: a bare clade-build invocation defaults to prod and overwrites trios.app. ` +
        `Build with the make forms documented in ${repoName}/.claude/skills/agent-safe-build/SKILL.md, ` +
        `or keep TRIOS_VARIANT=<variant> on the same line as the command.`
    );
    process.exit(1);
  }

  console.log(
    `[OK] clade-build-guard: no bare clade-build invocation in ${displayPath(skillsDir)}.`
  );
  process.exit(0);
}

main();
