#!/usr/bin/env node
/**
 * instruction-file-reach — a gate for the instruction files under trios/.
 *
 * Why this exists (trios#1392): a worker bee is dispatched into a
 * `git worktree` checkout, which contains exactly the tracked files of one
 * commit. An instruction file (CLAUDE.md or AGENTS.md) that is untracked,
 * or swallowed by an ignore rule, therefore never reaches the bee — and
 * because a plain `git add` of an ignored file silently does nothing,
 * nobody can commit a correction to it either, so it rots invisibly. This
 * tool makes that state a loud, exit-coded failure instead of a silent
 * one.
 *
 * What it checks, for every instruction file found by walking trios/:
 *
 *   1. Reachability (FR-004). A file is reachable only if `git ls-files`
 *      lists it AND `git check-ignore --no-index` does not match it.
 *      Either condition alone can be satisfied by a force-added file while
 *      the ignore trap that will eat the next edit stays armed — hence
 *      --no-index, and hence both conditions.
 *
 *   2. Command reality (FR-005). Every `bun run X` a document prescribes
 *      must be a script of the package.json governing the document's own
 *      directory — or, when the script lives in another workspace, the
 *      line must say so. A command no package.json in the tree defines is
 *      reported as missing; a command defined only elsewhere is reported
 *      with the workspaces that define it, which is what makes the
 *      document fixable rather than merely deletable.
 *
 *   3. Path reality (FR-006). Every backticked repository path must exist,
 *      resolved relative to the directory of the document that mentions
 *      it — the same rule a reader standing in that directory would apply
 *      (`lib/metrics/track.ts` in apps/agent/CLAUDE.md resolves only
 *      under this rule, never from the repository root).
 *
 * A backticked token counts as a repository path only if it:
 *   - contains a slash and ends in .md, .ts, .tsx, .json or .mjs;
 *   - contains no space and does not begin with `@` (so package
 *     specifiers such as `@browseros/shared/constants/ports` are not
 *     treated as files);
 * and, further, only if it is plausibly a path into THIS repository:
 *   - it is relative (no leading `/` or `~`: absolute and home paths
 *     point outside the repository by construction);
 *   - it carries no glob or template characters (`* ? { } < > $`: a
 *     pattern is not a path);
 *   - it has no leading dot-segment (`.trinity/`, `.claude/`, `./`,
 *     `../`: dot-directories in this tree are agent/runtime state, not
 *     repository source);
 *   - it is written in the lowercase path charset this repository uses
 *     for source files (`[a-z0-9/._-]`). Mixed-case tokens are proper
 *     nouns, date placeholders, or artifacts of foreign trees (for
 *     example `t27/fpga/HARDWARE_SSOT.md`, which belongs to another
 *     repository), not paths this gate can adjudicate.
 *
 * Exit code: 0 when everything holds; 1 when anything fails — including
 * the zero-files case, because enumerating nothing means the walk itself
 * is broken, not that the tree is clean.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Basenames that count as instruction files. */
export const INSTRUCTION_FILE_NAMES = ['CLAUDE.md', 'AGENTS.md'];

/**
 * Directories the walk never enters. Plain names are pruned at any depth;
 * the single slash-bearing entry (`rings/RUST-13`) is anchored to the walk
 * root. `rings/RUST-13/trios-mesh` is a git submodule (mode 160000): its
 * files cannot be landed through this repository, so they are outside the
 * gate's jurisdiction rather than unfixed failures.
 */
export const INSTRUCTION_FILE_EXCLUDED_DIRS = [
  '.worktrees',
  'node_modules',
  '_to_delete',
  'trios.app',
  'trios-dev.app',
  'trios-test.app',
  'rings/RUST-13',
];

const BUN_RUN_RE = /bun run ([A-Za-z0-9:@._-]+)/g;
const BACKTICK_RE = /`([^`\n]+)`/g;
const PATH_SUFFIX_RE = /\.(?:md|ts|tsx|json|mjs)$/;
const PATH_FORBIDDEN_RE = /[*?{}<>$\s]/;
const PATH_CHARSET_RE = /^[a-z0-9/._-]+$/;

function toPosix(p) {
  return p.split('\\').join('/');
}

function isExcludedDir(relDir) {
  const segments = relDir.split('/');
  for (const excluded of INSTRUCTION_FILE_EXCLUDED_DIRS) {
    if (excluded.includes('/')) {
      if (relDir === excluded || relDir.startsWith(`${excluded}/`)) return true;
    } else if (segments.includes(excluded)) {
      return true;
    }
  }
  return false;
}

/**
 * Walk `walkRoot` and return every instruction file as a POSIX path
 * relative to `walkRoot`, sorted. The filesystem is the source of truth:
 * no path and no count is hard-coded, so a freshly forgotten CLAUDE.md
 * shows up here and fails the reachability check.
 */
export function collectInstructionFiles(walkRoot) {
  const found = [];
  const visit = (absDir, relDir) => {
    const entries = readdirSync(absDir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (isExcludedDir(rel)) continue;
        visit(join(absDir, entry.name), rel);
      } else if (INSTRUCTION_FILE_NAMES.includes(entry.name)) {
        found.push(rel);
      }
    }
  };
  visit(walkRoot, '');
  return found.sort();
}

/**
 * Every package.json under `walkRoot` (same exclusions as the instruction
 * walk), as `{ absDir, relDir, scripts }` where `scripts` is a Set of the
 * manifest's script names.
 */
export function collectPackageManifests(walkRoot) {
  const manifests = [];
  const visit = (absDir, relDir) => {
    const pkgAbs = join(absDir, 'package.json');
    if (existsSync(pkgAbs)) {
      let scripts = new Set();
      try {
        const pkg = JSON.parse(readFileSync(pkgAbs, 'utf8'));
        scripts = new Set(Object.keys(pkg.scripts ?? {}));
      } catch {
        // An unparseable manifest contributes no scripts; the command
        // check below reports the fallout, so do not crash the walk here.
      }
      manifests.push({ absDir, relDir, scripts });
    }
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (isExcludedDir(rel)) continue;
      visit(join(absDir, entry.name), rel);
    }
  };
  visit(walkRoot, '');
  return manifests;
}

/** The package.json governing a document: the nearest one at or above it. */
function workspaceFor(absDocPath, manifests) {
  let dir = dirname(absDocPath);
  for (;;) {
    const hit = manifests.find((m) => m.absDir === dir);
    if (hit) return hit;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Does `line` name the workspace `definer` (so the reader is told where
 * the script actually lives)? Accepted spellings: the workspace relative
 * to the repository root (`trios/agent-server/apps/server`) or relative to
 * the document's own workspace (`apps/server`).
 */
function lineMentionsWorkspace(line, docWorkspace, definer, repoRoot) {
  const forms = [
    toPosix(relative(repoRoot, definer.absDir)),
    toPosix(relative(docWorkspace.absDir, definer.absDir)),
  ];
  for (const form of forms) {
    if (form && !form.startsWith('..') && line.includes(form)) return true;
  }
  return false;
}

function looksLikeRepositoryPath(candidate) {
  if (!candidate.includes('/')) return false; // FR-006: must contain a slash
  if (!PATH_SUFFIX_RE.test(candidate)) return false; // ...and end in a known suffix
  if (candidate.includes(' ')) return false; // ...with no space
  if (candidate.startsWith('@')) return false; // ...and not a package specifier
  if (candidate.startsWith('/') || candidate.startsWith('~')) return false; // outside the repo
  if (PATH_FORBIDDEN_RE.test(candidate)) return false; // glob/template, not a path
  if (candidate.startsWith('.')) return false; // dot-dir / ./ / ../ — runtime state
  if (!PATH_CHARSET_RE.test(candidate)) return false; // not this tree's source charset
  return true;
}

function runGit(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** The ignore rule matching `relPath`, or null when nothing matches it. */
function ignoreRuleFor(repoRoot, relPath) {
  try {
    const out = runGit(['check-ignore', '--no-index', '-v', '--', relPath], repoRoot);
    const first = out.split('\n')[0].split('\t')[0].trim();
    return first || '(matched, no rule printed)';
  } catch (err) {
    if (err.status === 1) return null; // exit 1: not ignored
    throw new Error(`git check-ignore failed for ${relPath}: ${err.stderr ?? err.message}`);
  }
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = runGit(['rev-parse', '--show-toplevel'], here).trim();
  const projectRoot = join(repoRoot, 'trios');
  if (!existsSync(projectRoot)) {
    console.error(`instruction-file-reach: ${projectRoot} does not exist; nothing to walk`);
    process.exitCode = 1;
    return;
  }
  const walkName = toPosix(relative(repoRoot, projectRoot)); // "trios"

  const filesRel = collectInstructionFiles(projectRoot);
  console.log(
    `instruction-file-reach: walked ${walkName}/ and found ${filesRel.length} instruction ` +
      `file(s) (${INSTRUCTION_FILE_NAMES.join(' | ')}) on the filesystem`,
  );
  if (filesRel.length === 0) {
    console.error(
      'instruction-file-reach: zero instruction files enumerated — the walk itself is broken',
    );
    process.exitCode = 1;
    return;
  }
  const files = filesRel.map((rel) => toPosix(join(walkName, rel)));

  const manifests = collectPackageManifests(projectRoot);
  const reachLines = [];
  const bunRunFailures = [];
  const pathFailures = [];
  const contentOks = [];
  const seenBunFail = new Set();
  const seenPathFail = new Set();

  // --- 1. Reachability (FR-004) -------------------------------------------
  const tracked = new Set(
    runGit(['ls-files', '--', ...files], repoRoot)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  );
  for (const rel of files) {
    const rule = ignoreRuleFor(repoRoot, rel);
    const isTracked = tracked.has(rel);
    if (!rule && isTracked) {
      reachLines.push(`ok   reach    ${rel}`);
      continue;
    }
    const why = [];
    if (rule && isTracked) {
      why.push(
        `force-added: tracked, but ignore rule \`${rule}\` is still armed and will eat the next edit`,
      );
    }
    if (rule && !isTracked) {
      why.push(`matched by ignore rule \`${rule}\`, so a plain \`git add\` of it silently does nothing`);
    }
    if (!isTracked) {
      why.push('absent from `git ls-files`, so no fresh checkout or worktree will ever contain it');
    }
    reachLines.push(`FAIL reach    ${rel}: ${why.join('; ')}`);
  }

  // --- 2. bun run reality (FR-005) and 3. path reality (FR-006) -----------
  for (const rel of files) {
    const abs = join(repoRoot, rel);
    let text;
    try {
      text = readFileSync(abs, 'utf8');
    } catch (err) {
      pathFailures.push(`${rel}: unreadable (${err.message})`);
      continue;
    }
    const lines = text.split(/\r?\n/);
    const docWorkspace = workspaceFor(abs, manifests);
    let contentOk = true;

    lines.forEach((line, idx) => {
      const lineNo = idx + 1;

      for (const m of line.matchAll(BUN_RUN_RE)) {
        const cmd = m[1];
        if (cmd.startsWith('-') || cmd.startsWith('.') || cmd.startsWith('/')) {
          continue; // a flag or a file argument, not a script name
        }
        if (docWorkspace && docWorkspace.scripts.has(cmd)) continue; // matches the governing manifest
        const definers = manifests.filter((m2) => m2.scripts.has(cmd));
        const key = `${rel}::${cmd}`;
        if (definers.length === 0) {
          contentOk = false;
          if (!seenBunFail.has(key)) {
            seenBunFail.add(key);
            bunRunFailures.push(
              `${rel}: \`bun run ${cmd}\` (line ${lineNo}) is not defined by any package.json ` +
                `under ${walkName}/ (node_modules excluded) — remove it or make it real`,
            );
          }
        } else if (!docWorkspace) {
          continue; // no governing manifest: a definition anywhere in the tree satisfies the mention
        } else if (definers.some((d) => lineMentionsWorkspace(line, docWorkspace, d, repoRoot))) {
          continue; // annotated with the workspace that defines it
        } else {
          contentOk = false;
          if (!seenBunFail.has(key)) {
            seenBunFail.add(key);
            const where = definers
              .map((d) => `${toPosix(relative(repoRoot, d.absDir))}/package.json`)
              .join(', ');
            bunRunFailures.push(
              `${rel}: \`bun run ${cmd}\` (line ${lineNo}) is not a script of ` +
                `${toPosix(relative(repoRoot, docWorkspace.absDir))}/package.json; it is defined in ` +
                `${where} — annotate the line with that workspace or drop the command`,
            );
          }
        }
      }

      for (const m of line.matchAll(BACKTICK_RE)) {
        const candidate = m[1];
        if (!looksLikeRepositoryPath(candidate)) continue;
        const resolvedAbs = resolve(dirname(abs), candidate);
        if (existsSync(resolvedAbs)) continue;
        contentOk = false;
        const key = `${rel}::${candidate}`;
        if (!seenPathFail.has(key)) {
          seenPathFail.add(key);
          pathFailures.push(
            `${rel}: \`${candidate}\` (line ${lineNo}) does not exist — resolved relative to the ` +
              `document's directory: ${toPosix(relative(repoRoot, resolvedAbs))}`,
          );
        }
      }
    });

    if (contentOk) {
      contentOks.push(`ok   content  ${rel} (bun run commands and repository paths resolve)`);
    }
  }

  // --- Report --------------------------------------------------------------
  for (const line of reachLines) console.log(line);
  if (bunRunFailures.length > 0) {
    console.log('--- bun run commands that resolve nowhere, or only in another workspace ---');
    for (const f of bunRunFailures) console.log(`FAIL bun-run  ${f}`);
  }
  if (pathFailures.length > 0) {
    console.log('--- backticked repository paths that do not exist ---');
    for (const f of pathFailures) console.log(`FAIL path     ${f}`);
  }
  for (const line of contentOks) console.log(line);
  const total = bunRunFailures.length + pathFailures.length +
    reachLines.filter((l) => l.startsWith('FAIL')).length;
  console.log(
    `summary: ${files.length} instruction files enumerated from the filesystem; ` +
      `${reachLines.filter((l) => l.startsWith('FAIL')).length} unreachable; ` +
      `${bunRunFailures.length} unresolved bun run commands; ${pathFailures.length} unresolved paths`,
  );
  if (total > 0) {
    console.error(`instruction-file-reach: FAIL (${total} problem(s) listed above)`);
    process.exitCode = 1;
  } else {
    console.log('instruction-file-reach: OK');
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main();
}
