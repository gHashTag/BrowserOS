// tools/agent-roster-audit.mjs
//
// Drift gate for the prose agent roster in AGENTS.md.
//
// The roster exists twice: as the table in AGENTS.md and as the
// machine-readable .claude/agents/registry.json. The registry is the
// copy that stays correct, so this tool checks the prose copy
// against the tree, in one direction only:
//
//   1. Every backticked "*.md" name in the last cell of a roster
//      table row must exist under .claude/agents/ (reported with its
//      AGENTS.md line number when it does not).
//   2. Every such name must have an entry in
//      .claude/agents/registry.json. The opposite direction is not a
//      defect of this document: a soul file on disk with no registry
//      entry is left alone.
//   3. Every backticked target in the second cell of a row of the
//      Constitutional Stack table must resolve from the project
//      root: a plain path must exist, and a glob must match at least
//      one file. A glob that matches nothing is a defect; a zero
//      match passing silently is how row 5 survived.
//
// Nothing about the roster is baked in. Letters, file names and all
// counts are read from the file system at run time, so a future
// rename or removal cannot pass by coincidence.
//
// Usage:
//   node trios/tools/agent-roster-audit.mjs [alternate-AGENTS.md]
//
// The optional argument names an AGENTS.md snapshot to parse, for
// replaying an older revision through the finished tool. Roster,
// registry and skill paths always resolve against this checkout,
// located from the script's own position, never against the current
// working directory or the snapshot's directory.
//
// Output: one line per defect on stdout, nothing when clean.
// Exit status: 0 clean, 1 defects found, 2 environment error.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectDir = dirname(scriptDir);
const agentsDir = join(projectDir, ".claude", "agents");
const registryPath = join(agentsDir, "registry.json");
const defaultDocPath = join(projectDir, "AGENTS.md");

const argDoc = process.argv[2];
const docPath = argDoc === undefined ? defaultDocPath : argDoc;
const docLabel = argDoc === undefined ? "trios/AGENTS.md" : argDoc;

function envError(message) {
  process.stderr.write("agent-roster-audit: " + message + "\n");
  process.exit(2);
}

function readDocumentLines() {
  try {
    return readFileSync(docPath, "utf8").split(/\r?\n/);
  } catch (err) {
    envError("cannot read " + docPath + ": " + err.message);
    return [];
  }
}

function loadRegistryFileNames() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(registryPath, "utf8"));
  } catch (err) {
    envError("cannot read " + registryPath + ": " + err.message);
    return new Set();
  }
  const names = new Set();
  const agents = parsed !== null && Array.isArray(parsed.agents) ? parsed.agents : [];
  for (const entry of agents) {
    if (entry !== null && typeof entry.file === "string") {
      names.add(basename(entry.file));
    }
  }
  return names;
}

// -- markdown tables ----------------------------------------------------

function isTableRowLine(line) {
  return /^\s*\|/.test(line);
}

function splitRowCells(line) {
  let body = line.trim();
  if (body.startsWith("|")) {
    body = body.slice(1);
  }
  if (body.endsWith("|")) {
    body = body.slice(0, -1);
  }
  return body.split("|").map((cell) => cell.trim());
}

function isSeparatorRow(cells) {
  return (
    cells.length > 0 &&
    cells.every((cell) => cell === "" || /^:?-{3,}:?$/.test(cell))
  );
}

function collectTables(lines) {
  const tables = [];
  let current = null;
  lines.forEach((line, index) => {
    if (!isTableRowLine(line)) {
      current = null;
      return;
    }
    if (current === null) {
      current = { startLine: index + 1, rows: [] };
      tables.push(current);
    }
    const cells = splitRowCells(line);
    if (!isSeparatorRow(cells)) {
      current.rows.push({ line: index + 1, cells: cells });
    }
  });
  return tables;
}

function backtickedNames(text) {
  const names = [];
  const pattern = /`([^`]+)`/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    names.push(match[1]);
  }
  return names;
}

// -- roster table versus disk and registry ------------------------------

function collectRosterDefects(lines, registryFileNames) {
  const defects = [];
  let namedCount = 0;
  for (const table of collectTables(lines)) {
    for (const row of table.rows) {
      const lastCell = row.cells.length > 0 ? row.cells[row.cells.length - 1] : "";
      for (const name of backtickedNames(lastCell)) {
        if (!name.endsWith(".md")) {
          continue;
        }
        namedCount += 1;
        const soulPath = name.includes("/")
          ? join(projectDir, name)
          : join(agentsDir, name);
        if (!existsSync(soulPath)) {
          defects.push(
            docLabel + ":" + row.line + ": roster row names " + name +
              " but no such file exists under .claude/agents/"
          );
        }
        if (!registryFileNames.has(basename(name))) {
          defects.push(
            docLabel + ":" + row.line + ": roster row names " + name +
              " but .claude/agents/registry.json has no entry for it"
          );
        }
      }
    }
  }
  if (namedCount === 0) {
    defects.push(
      docLabel + ": no table row names a soul file; the roster table " +
        "has moved or been renamed beyond this tool's reach"
    );
  }
  return defects;
}

// -- constitutional stack versus the tree -------------------------------

function findStackTable(lines) {
  let headingIndex = -1;
  lines.forEach((line, index) => {
    if (
      headingIndex === -1 &&
      /^#{1,6}\s/.test(line) &&
      /constitutional\s+stack/i.test(line)
    ) {
      headingIndex = index;
    }
  });
  if (headingIndex === -1) {
    return null;
  }
  for (const table of collectTables(lines)) {
    if (table.startLine > headingIndex + 1) {
      return table;
    }
  }
  return null;
}

function segmentToRegExp(segment) {
  let source = "^";
  for (const ch of segment) {
    if (ch === "*") {
      source += "[^/]*";
    } else if (ch === "?") {
      source += "[^/]";
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      source += "\\" + ch;
    } else {
      source += ch;
    }
  }
  return new RegExp(source + "$");
}

function globExpand(dir, segments, index) {
  if (index >= segments.length) {
    return [dir];
  }
  const segment = segments[index];
  const isLast = index === segments.length - 1;
  const regex = /[*?]/.test(segment) ? segmentToRegExp(segment) : null;
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return [];
  }
  const matches = [];
  for (const entry of entries) {
    if (regex !== null) {
      if (!regex.test(entry.name)) {
        continue;
      }
    } else if (entry.name !== segment) {
      continue;
    }
    const child = join(dir, entry.name);
    if (isLast) {
      matches.push(child);
    } else if (entry.isDirectory()) {
      matches.push(...globExpand(child, segments, index + 1));
    }
  }
  return matches;
}

function countGlobMatches(pattern) {
  const segments = pattern.split("/").filter((s) => s !== "" && s !== ".");
  return globExpand(projectDir, segments, 0).length;
}

function resolveStackTargets(lines) {
  const defects = [];
  const table = findStackTable(lines);
  if (table === null) {
    defects.push(
      docLabel + ": Constitutional Stack heading or table not found; " +
        "stack targets left unchecked"
    );
    return defects;
  }
  for (const row of table.rows) {
    if (row.cells.length < 2) {
      continue;
    }
    for (const target of backtickedNames(row.cells[1])) {
      if (/[*?]/.test(target)) {
        if (countGlobMatches(target) === 0) {
          defects.push(
            docLabel + ":" + row.line + ": stack glob " + target +
              " matches no files"
          );
        }
      } else if (!existsSync(join(projectDir, target))) {
        defects.push(
          docLabel + ":" + row.line + ": stack path " + target +
            " does not exist"
        );
      }
    }
  }
  return defects;
}

// -- main ----------------------------------------------------------------

const lines = readDocumentLines();
const registryFileNames = loadRegistryFileNames();
const defects = [
  ...collectRosterDefects(lines, registryFileNames),
  ...resolveStackTargets(lines),
];
for (const defect of defects) {
  process.stdout.write(defect + "\n");
}
process.exitCode = defects.length > 0 ? 1 : 0;
