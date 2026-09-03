// trios/tools/generated-provenance.mjs -- provenance gate for generated ring artifacts.
//
// Law L0 (trios/CLAUDE.md): "Generated files are artifacts. They are not
// edited. A diff that changes a generated file without changing its .t27 is a
// defect." Nothing enforced that sentence; a generated file could be edited,
// committed, and every gate stayed green. This tool enforces it by provenance:
// it records what a ring's .t27 spec hashed to at the moment its generated/
// artifact was accepted, and compares that record against the spec on every
// later run. The worker image has no t27c, so regeneration cannot be the
// check (FR-001): this tool runs no compiler and never regenerates anything.
// It only reads and hashes files (FR-005: Node standard library only).
//
// Model of a ring (a directory directly under the rings root):
//   <ring>/*.t27                     the spec, the source of truth
//   <ring>/generated/                the artifact directory, the generated files
//   <ring>/generated.provenance.json the record this tool writes and checks
//
// States, one line per ring (FR-002 keeps unknown and stale distinct states
// with distinct lines; treating an unrecorded ring as fresh is the failure
// mode that would make this gate worthless):
//   fresh        generated/ exists, a record exists, spec hash matches it
//   stale        generated/ exists, a record exists, spec hash differs
//                (the line names the ring, the recorded hash, the current one)
//   unknown      generated/ exists, no record names its origin
//   no-generated no generated/ directory; nothing to hold to the law yet
//
// Usage:
//   node trios/tools/generated-provenance.mjs                check all rings
//   node trios/tools/generated-provenance.mjs --ring NAME    check one ring
//   node trios/tools/generated-provenance.mjs --record       write baselines
//   node trios/tools/generated-provenance.mjs --selftest     fixture selftest
//   node trios/tools/generated-provenance.mjs --help
//   --rings-root DIR  point at another rings tree (how --selftest is fed)
//
// Exit codes:
//   0  the gate passed; or every requested record was written
//   1  a ring is stale or unknown; or a record was refused
//   2  the tool was pointed at nothing it could use (no rings, bad flags)
//
// --record (FR-003) refuses to write a baseline while the working tree has
// uncommitted changes under the ring it would record, so a baseline is never
// taken over an unreviewed edit. The provenance record file itself is the one
// exclusion: it is this tool's own output, not an edit under review, and
// counting it would make --record refuse its own second run.
//
// Hashing (FR-004) is over file CONTENTS only, in a sorted, printed order.
// The spec of a ring is its *.t27 files directly under the ring directory,
// sorted by path (UTF-16 code unit order, identical on every machine). Each
// file is hashed as the sha256 of its bytes; the ring's aggregate spec hash
// is the sha256 of "<path>\n<file-sha256-hex>\n" for every file in that
// sorted order. No timestamps, no permissions, no metadata: the same tree
// hashes the same on any machine. The sorted order is printed on every check
// and record line and stored inside the record, so it can be reproduced and
// audited by hand.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RECORD_NAME = "generated.provenance.json";
const ARTIFACT_DIR = "generated";
const SPEC_SUFFIX = ".t27";
const HASH_ALGO = "sha256";

function defaultRingsRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "rings");
}

function sha256Hex(buffer) {
  return createHash(HASH_ALGO).update(buffer).digest("hex");
}

function isHex64(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function errText(err) {
  return String(err && err.message ? err.message : err);
}

// The spec files of a ring: *.t27 directly under the ring directory, sorted.
// The sorted order is part of the hash, so it must be the same everywhere.
function listSpecFiles(ringDir) {
  let entries;
  try {
    entries = fs.readdirSync(ringDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(SPEC_SUFFIX))
    .map((entry) => entry.name)
    .sort();
}

// Provenance of a ring's spec: the per-file hashes and the aggregate. The
// aggregate covers the path and the content of every file, in sorted order,
// and nothing else, so it is reproducible on another machine.
function specProvenance(ringDir) {
  const files = listSpecFiles(ringDir).map((name) => ({
    path: name,
    sha256: sha256Hex(fs.readFileSync(path.join(ringDir, name))),
  }));
  const hash = createHash(HASH_ALGO);
  for (const file of files) {
    hash.update(file.path + "\n" + file.sha256 + "\n");
  }
  return { files, specHash: hash.digest("hex") };
}

function hasArtifactDir(ringDir) {
  const artifactDir = path.join(ringDir, ARTIFACT_DIR);
  try {
    return fs.statSync(artifactDir).isDirectory();
  } catch {
    return false;
  }
}

function readRecord(ringDir) {
  const recordPath = path.join(ringDir, RECORD_NAME);
  if (!fs.existsSync(recordPath)) {
    return { present: false };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    if (!parsed || typeof parsed !== "object") {
      throw new Error("record is not a JSON object");
    }
    return { present: true, record: parsed };
  } catch (err) {
    return { present: true, broken: errText(err) };
  }
}

// The check itself. Pure: reads the ring, decides its state, changes nothing.
// No compiler, no regeneration, no git (FR-001).
function ringProvenance(ringDir) {
  const ring = path.basename(ringDir);
  const base = { ring, specFiles: [], specHash: null, recordedHash: null };

  if (!fs.existsSync(ringDir)) {
    return { ...base, state: "no-generated", note: "no ring directory at " + ringDir };
  }
  if (!hasArtifactDir(ringDir)) {
    return {
      ...base,
      state: "no-generated",
      note: "no " + ARTIFACT_DIR + "/ directory; no artifact to hold to the law yet",
    };
  }

  let spec;
  try {
    spec = specProvenance(ringDir);
  } catch (err) {
    return {
      ...base,
      state: "unknown",
      note: "the spec could not be hashed: " + errText(err),
    };
  }
  const withFiles = { ...base, specFiles: spec.files, specHash: spec.specHash };

  if (spec.files.length === 0) {
    return {
      ...withFiles,
      state: "unknown",
      note: ARTIFACT_DIR + "/ is present but no " + SPEC_SUFFIX + " spec names its source",
    };
  }

  const rec = readRecord(ringDir);
  if (!rec.present) {
    return {
      ...withFiles,
      state: "unknown",
      note:
        ARTIFACT_DIR + "/ exists but " + RECORD_NAME + " never recorded its origin",
    };
  }
  if (rec.broken) {
    return {
      ...withFiles,
      state: "unknown",
      note: RECORD_NAME + " exists but is unreadable: " + rec.broken,
    };
  }
  if (
    rec.record.version !== 1 ||
    rec.record.algorithm !== HASH_ALGO ||
    !isHex64(rec.record.specHash)
  ) {
    return {
      ...withFiles,
      state: "unknown",
      note: RECORD_NAME + " does not hold a version 1 " + HASH_ALGO + " record",
    };
  }

  if (rec.record.specHash === spec.specHash) {
    return {
      ...withFiles,
      recordedHash: rec.record.specHash,
      state: "fresh",
      note: "spec hash matches the record",
    };
  }
  return {
    ...withFiles,
    recordedHash: rec.record.specHash,
    state: "stale",
    note: "the spec changed after the artifact was generated",
  };
}

// One printed line per ring. The sorted file order is printed on every line
// that has a spec (FR-004: the hashing order is visible, not implicit).
function describeRing(result) {
  const files = result.specFiles.map((file) => file.path).join(",");
  const order = files ? " files=" + files : "";
  switch (result.state) {
    case "fresh":
      return (
        result.ring +
        ": fresh spec=" +
        HASH_ALGO +
        ":" +
        result.specHash +
        order
      );
    case "stale":
      return (
        result.ring +
        ": stale recorded=" +
        HASH_ALGO +
        ":" +
        result.recordedHash +
        " current=" +
        HASH_ALGO +
        ":" +
        result.specHash +
        order +
        " (" +
        result.note +
        ")"
      );
    default:
      return result.ring + ": " + result.state + " (" + result.note + ")" + order;
  }
}

function discoverRings(ringsRoot) {
  let entries;
  try {
    entries = fs.readdirSync(ringsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function scopedRings(ringsRoot, onlyRing, io) {
  const rings = discoverRings(ringsRoot);
  if (onlyRing !== null) {
    if (!rings.includes(onlyRing)) {
      io.out("no ring named '" + onlyRing + "' under " + ringsRoot);
      return null;
    }
    return [onlyRing];
  }
  return rings;
}

function runCheck(ringsRoot, onlyRing, io) {
  const rings = scopedRings(ringsRoot, onlyRing, io);
  if (rings === null) {
    return 2;
  }
  if (rings.length === 0) {
    io.out(
      "no rings found under " +
        ringsRoot +
        " - nothing to check, and that is not a pass"
    );
    return 2;
  }

  const counts = { fresh: 0, stale: 0, unknown: 0, "no-generated": 0 };
  for (const ring of rings) {
    const result = ringProvenance(path.join(ringsRoot, ring));
    if (!(result.state in counts)) {
      counts[result.state] = 0;
    }
    counts[result.state] += 1;
    io.out(describeRing(result));
  }

  io.out(
    "total rings=" +
      rings.length +
      " fresh=" +
      counts.fresh +
      " stale=" +
      counts.stale +
      " unknown=" +
      counts.unknown +
      " no-generated=" +
      counts["no-generated"]
  );
  const bad = counts.stale + counts.unknown;
  if (bad > 0) {
    io.out(
      "gate: FAIL - " +
        bad +
        " ring(s) whose generated/ origin is not backed by the current spec " +
        "(stale=" +
        counts.stale +
        ", unknown=" +
        counts.unknown +
        ")"
    );
    return 1;
  }
  io.out("gate: PASS - every generated/ artifact is backed by the current spec");
  return 0;
}

function git(ringDir, args) {
  try {
    const out = execFileSync("git", ["-C", ringDir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (err) {
    return {
      code: err.status === null || err.status === undefined ? -1 : err.status,
      out: err.stdout || "",
      stderr: err.stderr || "",
    };
  }
}

// Uncommitted changes under the ring, for --record (FR-003). The provenance
// record file itself is excluded: it is this tool's own output, not an edit
// under review, and counting it would make --record refuse its own rerun.
function uncommittedUnderRing(ringDir) {
  const inside = git(ringDir, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.out.trim() !== "true") {
    return {
      verifiable: false,
      reason: "cannot verify a git working tree under " + ringDir,
    };
  }
  const status = git(ringDir, [
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    ".",
  ]);
  if (status.code !== 0) {
    return {
      verifiable: false,
      reason:
        "git status failed under " +
        ringDir +
        ": " +
        (status.stderr || status.out).trim(),
    };
  }
  const dirty = status.out
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .filter((line) => {
      // The path starts after the two-letter status and one space.
      let p = line.slice(3);
      if (p.startsWith('"')) {
        return true; // quoted or unusual path: keep it, stay conservative
      }
      const arrow = p.indexOf(" -> ");
      if (arrow !== -1) {
        p = p.slice(arrow + 4);
      }
      return p !== RECORD_NAME && !p.endsWith("/" + RECORD_NAME);
    });
  return { verifiable: true, dirty };
}

function recordRing(ringDir, io) {
  const ring = path.basename(ringDir);

  if (!hasArtifactDir(ringDir)) {
    return { status: "skipped" };
  }
  if (listSpecFiles(ringDir).length === 0) {
    io.out(
      "refuse " +
        ring +
        ": " +
        ARTIFACT_DIR +
        "/ is present but no " +
        SPEC_SUFFIX +
        " spec exists to record provenance against"
    );
    return { status: "refused" };
  }

  const clean = uncommittedUnderRing(ringDir);
  if (!clean.verifiable) {
    io.out(
      "refuse " +
        ring +
        ": " +
        clean.reason +
        "; refusing to record (FR-003: a baseline is never taken over an unverifiable tree)"
    );
    return { status: "refused" };
  }
  if (clean.dirty.length > 0) {
    io.out(
      "refuse " +
        ring +
        ": the working tree has uncommitted changes under the ring; " +
        "a baseline cannot be taken over an unreviewed edit (FR-003):"
    );
    for (const line of clean.dirty.slice(0, 10)) {
      io.out("    " + line);
    }
    if (clean.dirty.length > 10) {
      io.out("    ... and " + (clean.dirty.length - 10) + " more");
    }
    return { status: "refused" };
  }

  const spec = specProvenance(ringDir);
  const record = {
    version: 1,
    ring,
    algorithm: HASH_ALGO,
    hashPlan:
      "sha256 over \"<path>\\n<per-file-sha256-hex>\\n\" for each " +
      SPEC_SUFFIX +
      " file directly under the ring, in sorted path order",
    recordedAt: new Date().toISOString(),
    specFiles: spec.files,
    specHash: spec.specHash,
  };
  const recordPath = path.join(ringDir, RECORD_NAME);
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2) + "\n", "utf8");

  const order = spec.files.map((file) => file.path).join(", ");
  io.out(
    "recorded " +
      ring +
      ": spec " +
      HASH_ALGO +
      ":" +
      spec.specHash +
      " over files in sorted order [" +
      order +
      "] -> " +
      recordPath
  );
  return { status: "recorded" };
}

function runRecord(ringsRoot, onlyRing, io) {
  const rings = scopedRings(ringsRoot, onlyRing, io);
  if (rings === null) {
    return 2;
  }
  if (rings.length === 0) {
    io.out("no rings found under " + ringsRoot + " - nothing to record");
    return 2;
  }

  const counts = { recorded: 0, refused: 0, skipped: 0 };
  for (const ring of rings) {
    const result = recordRing(path.join(ringsRoot, ring), io);
    counts[result.status] += 1;
    if (result.status === "skipped") {
      io.out(
        "skip " +
          ring +
          ": no " +
          ARTIFACT_DIR +
          "/ directory - no artifact to record provenance for"
      );
    }
  }

  io.out(
    "record: recorded=" +
      counts.recorded +
      " refused=" +
      counts.refused +
      " skipped=" +
      counts.skipped +
      " (rings root " +
      ringsRoot +
      ")"
  );
  if (counts.recorded === 0 && counts.refused === 0) {
    io.out(
      "record: nothing to record - no ring has both a " +
        SPEC_SUFFIX +
        " spec and a " +
        ARTIFACT_DIR +
        "/ directory"
    );
  }
  if (counts.refused > 0) {
    io.out(
      "record: REFUSED - no baseline was taken for " +
        counts.refused +
        " ring(s); commit or discard the changes, then run --record again"
    );
    return 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Selftest: fixture rings in a temporary directory, a real git repository so
// the --record path runs for true, and one planted one-byte spec change that
// must read as stale. Asserts all four states and the refusal paths.
// ---------------------------------------------------------------------------

function capture() {
  const c = { text: "" };
  c.io = { out: (line) => { c.text += line + "\n"; } };
  return c;
}

function gitIn(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function commitAll(cwd, message) {
  gitIn(cwd, ["add", "-A"]);
  gitIn(cwd, [
    "-c",
    "user.name=generated-provenance selftest",
    "-c",
    "user.email=selftest@localhost",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    message,
  ]);
}

function makeFixtureRing(ringsRoot, name, specBody, withGenerated) {
  const ringDir = path.join(ringsRoot, name);
  fs.mkdirSync(ringDir, { recursive: true });
  fs.writeFileSync(path.join(ringDir, "spec.t27"), specBody);
  if (withGenerated) {
    fs.mkdirSync(path.join(ringDir, ARTIFACT_DIR));
    fs.writeFileSync(
      path.join(ringDir, ARTIFACT_DIR, "out.rs"),
      "// generated fixture output, the artifact under test\n"
    );
  }
  return ringDir;
}

function runSelftest(io) {
  const tmp = fs.mkdtempSync(
    path.join(os.tmpdir(), "generated-provenance-selftest-")
  );
  let assertions = 0;
  let failures = 0;
  const ok = (cond, label, detail) => {
    assertions += 1;
    if (cond) {
      io.out("ok " + assertions + " - " + label);
    } else {
      failures += 1;
      const clipped = detail ? " :: " + String(detail).slice(0, 400) : "";
      io.out("not ok " + assertions + " - " + label + clipped);
    }
  };

  try {
    const ringsRoot = path.join(tmp, "rings");
    fs.mkdirSync(ringsRoot);
    execFileSync("git", ["init", "-q", tmp], { stdio: ["ignore", "pipe", "pipe"] });
    io.out("selftest fixture: " + ringsRoot + " (git repository at " + tmp + ")");

    const freshDir = makeFixtureRing(
      ringsRoot,
      "FRESH-00",
      "// fixture spec: FRESH-00\nlaw: one rule, generated, not transcribed\n",
      true
    );
    const staleDir = makeFixtureRing(
      ringsRoot,
      "STALE-00",
      "// fixture spec: STALE-00\nlaw: one rule, generated, not transcribed\n",
      true
    );
    const unknownDir = makeFixtureRing(
      ringsRoot,
      "UNKNOWN-00",
      "// fixture spec: UNKNOWN-00\nlaw: one rule, generated, not transcribed\n",
      true
    );
    const nospecDir = makeFixtureRing(
      ringsRoot,
      "NOSPEC-00",
      "",
      true
    );
    fs.rmSync(path.join(nospecDir, "spec.t27"));
    const nogenDir = makeFixtureRing(
      ringsRoot,
      "NOGEN-00",
      "// fixture spec: NOGEN-00\nlaw: one rule, generated, not transcribed\n",
      false
    );
    commitAll(tmp, "fixture rings, before any provenance records");

    // Baselines through the real record path; the fixture tree is clean here.
    let cap = capture();
    let code = runRecord(ringsRoot, "FRESH-00", cap.io);
    ok(code === 0, "record on a clean ring exits 0", "exit=" + code + " " + cap.text);
    ok(
      cap.text.includes("recorded FRESH-00") &&
        cap.text.includes("files in sorted order [spec.t27]"),
      "record prints what it wrote: ring, hash, sorted file order, path",
      cap.text
    );

    cap = capture();
    code = runRecord(ringsRoot, "STALE-00", cap.io);
    ok(code === 0, "record on the second clean ring exits 0", "exit=" + code);
    commitAll(tmp, "record provenance baselines for FRESH-00 and STALE-00");

    // UNKNOWN-00 deliberately keeps no record; NOSPEC-00 has no spec.

    const fresh = ringProvenance(freshDir);
    ok(
      fresh.state === "fresh",
      "FRESH-00: recorded hash equal to the current spec hash reads fresh",
      JSON.stringify(fresh)
    );
    ok(
      isHex64(fresh.specHash) && fresh.specHash === fresh.recordedHash,
      "FRESH-00: the fresh result carries the recorded and current hashes",
      JSON.stringify(fresh)
    );

    // Plant exactly one byte of change in STALE-00's spec, uncommitted.
    const specPath = path.join(staleDir, "spec.t27");
    const before = fs.readFileSync(specPath);
    const mutated = Buffer.from(before);
    const last = mutated[mutated.length - 1];
    mutated[mutated.length - 1] = last === 0x0a ? 0x61 : 0x0a;
    fs.writeFileSync(specPath, mutated);

    const stale = ringProvenance(staleDir);
    ok(
      stale.state === "stale",
      "STALE-00: a one-byte spec change after recording reads stale",
      JSON.stringify(stale)
    );
    ok(
      isHex64(stale.recordedHash) &&
        isHex64(stale.specHash) &&
        stale.recordedHash !== stale.specHash,
      "STALE-00: recorded and current hashes are both named and differ",
      JSON.stringify(stale)
    );
    ok(
      before.length === fs.readFileSync(specPath).length &&
        Buffer.compare(before, fs.readFileSync(specPath)) !== 0,
      "STALE-00: the planted change was exactly one byte, same length",
      ""
    );

    const unknown = ringProvenance(unknownDir);
    ok(
      unknown.state === "unknown",
      "UNKNOWN-00: generated/ with no record reads unknown, not fresh (FR-002)",
      JSON.stringify(unknown)
    );
    const nospec = ringProvenance(nospecDir);
    ok(
      nospec.state === "unknown",
      "NOSPEC-00: generated/ with no .t27 spec reads unknown",
      JSON.stringify(nospec)
    );
    const nogen = ringProvenance(nogenDir);
    ok(
      nogen.state === "no-generated",
      "NOGEN-00: a ring with no generated/ reads no-generated",
      JSON.stringify(nogen)
    );

    // The aggregate follows the documented plan: path, file sha256, sorted.
    const plan = createHash(HASH_ALGO);
    for (const file of specProvenance(freshDir).files) {
      plan.update(file.path + "\n" + file.sha256 + "\n");
    }
    ok(
      plan.digest("hex") === fresh.specHash,
      "the aggregate hash follows the documented sorted, printed plan (FR-004)",
      ""
    );

    // The written record is a versioned sha256 record that matches the ring.
    const recordJson = JSON.parse(
      fs.readFileSync(path.join(freshDir, RECORD_NAME), "utf8")
    );
    ok(
      recordJson.version === 1 &&
        recordJson.algorithm === HASH_ALGO &&
        isHex64(recordJson.specHash) &&
        recordJson.specHash === fresh.specHash &&
        Array.isArray(recordJson.specFiles) &&
        recordJson.specFiles.length === 1 &&
        recordJson.specFiles[0].path === "spec.t27",
      "the record file holds a version 1 sha256 record matching the ring",
      JSON.stringify(recordJson)
    );

    // Full gate over the fixture tree: four states, distinct lines, totals.
    cap = capture();
    code = runCheck(ringsRoot, null, cap.io);
    ok(
      code === 1,
      "the gate exits non-zero while a stale and an unknown ring exist",
      "exit=" + code + " " + cap.text
    );
    ok(
      cap.text.includes("STALE-00: stale recorded=sha256:") &&
        /STALE-00: stale recorded=sha256:[0-9a-f]{64} current=sha256:[0-9a-f]{64}/.test(
          cap.text
        ),
      "the stale line names the ring, the recorded hash and the current one",
      cap.text
    );
    ok(
      cap.text.includes("UNKNOWN-00: unknown") &&
        !cap.text.includes("UNKNOWN-00: stale") &&
        !cap.text.includes("UNKNOWN-00: fresh"),
      "the unknown line is its own line, never stale or fresh (FR-002)",
      cap.text
    );
    ok(
      cap.text.includes("FRESH-00: fresh") &&
        cap.text.includes("NOGEN-00: no-generated") &&
        cap.text.includes("NOSPEC-00: unknown"),
      "fresh, no-generated and the second unknown ring each print their line",
      cap.text
    );
    ok(
      /total rings=5 fresh=1 stale=1 unknown=2 no-generated=1/.test(cap.text),
      "the totals line counts all rings and all four states",
      cap.text
    );

    // Scoped check over only good rings passes.
    cap = capture();
    code = runCheck(ringsRoot, "FRESH-00", cap.io);
    ok(
      code === 0 &&
        cap.text.includes("FRESH-00: fresh") &&
        cap.text.includes("gate: PASS"),
      "a scoped check over a fresh ring passes with exit 0",
      "exit=" + code + " " + cap.text
    );

    // --record on a dirty ring refuses, and says why (FR-003). STALE-00 is
    // dirty from the one-byte plant above.
    cap = capture();
    code = runRecord(ringsRoot, "STALE-00", cap.io);
    ok(
      code === 1,
      "--record on a ring with uncommitted changes exits non-zero (FR-003)",
      "exit=" + code + " " + cap.text
    );
    ok(
      cap.text.includes("refuse STALE-00") &&
        cap.text.includes("uncommitted changes") &&
        /M .*spec\.t27|MM .*spec\.t27/.test(cap.text),
      "--record says why: names the ring, the law, and the offending path",
      cap.text
    );

    // --record on a ring with generated/ but no spec refuses too.
    cap = capture();
    code = runRecord(ringsRoot, "NOSPEC-00", cap.io);
    ok(
      code === 1 && cap.text.includes("refuse NOSPEC-00"),
      "--record refuses a generated/ directory with no spec to record against",
      "exit=" + code + " " + cap.text
    );

    // Re-recording a clean ring works, including immediately after a record
    // write left the record file itself uncommitted: the tool's own record is
    // not an unreviewed edit.
    cap = capture();
    code = runRecord(ringsRoot, "FRESH-00", cap.io);
    const firstRerecord = code;
    cap = capture();
    code = runRecord(ringsRoot, "FRESH-00", cap.io);
    ok(
      firstRerecord === 0 &&
        code === 0 &&
        cap.text.includes("recorded FRESH-00"),
      "re-recording works twice in a row: the record file is not held against itself",
      "exit1=" + firstRerecord + " exit2=" + code + " " + cap.text
    );

    // After re-recording FRESH-00 with its unchanged spec, it is still fresh.
    ok(
      ringProvenance(freshDir).state === "fresh",
      "FRESH-00 is still fresh after re-recording the same spec",
      ""
    );

    // A ring name that does not exist is an error, not a silent pass.
    cap = capture();
    code = runCheck(ringsRoot, "NO-SUCH-RING", cap.io);
    ok(
      code === 2,
      "asking for a ring that does not exist exits 2, not 0",
      "exit=" + code + " " + cap.text
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    io.out("selftest: removed " + tmp);
  }

  if (failures === 0) {
    io.out("selftest: PASS (" + assertions + " assertions)");
    return 0;
  }
  io.out(
    "selftest: FAIL (" + failures + " of " + assertions + " assertions failed)"
  );
  return 1;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function usage(io) {
  io.out("usage: node trios/tools/generated-provenance.mjs [--record] [--selftest] [--ring NAME] [--rings-root DIR]");
  io.out("");
  io.out("  (no flags)   check every ring under the rings root; one line per ring,");
  io.out("              one of fresh / stale / unknown / no-generated, plus totals");
  io.out("  --record     write the current spec hashes as the provenance record;");
  io.out("              refuses any ring with uncommitted changes under it");
  io.out("  --selftest   build fixture rings in a temporary directory, assert all");
  io.out("              four states and the refusal paths, exit 0 on success");
  io.out("  --ring NAME  limit the run to one ring");
  io.out("  --rings-root DIR  rings tree to scan (default: ../rings beside this tool)");
  io.out("  --help       this text");
}

function main(argv, io) {
  let mode = "check";
  let onlyRing = null;
  let ringsRootArg = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--record") {
      mode = "record";
    } else if (arg === "--selftest") {
      mode = "selftest";
    } else if (arg === "--help" || arg === "-h") {
      usage(io);
      return 0;
    } else if (arg === "--ring") {
      onlyRing = argv[i + 1];
      if (!onlyRing) {
        io.out("flag --ring needs a ring name");
        return 2;
      }
      i += 1;
    } else if (arg === "--rings-root") {
      ringsRootArg = argv[i + 1];
      if (!ringsRootArg) {
        io.out("flag --rings-root needs a directory");
        return 2;
      }
      i += 1;
    } else {
      io.out("unknown argument '" + arg + "'");
      usage(io);
      return 2;
    }
  }

  if (mode === "selftest") {
    if (ringsRootArg !== null || onlyRing !== null) {
      io.out("--selftest builds its own fixture rings; --rings-root and --ring do not apply to it");
      return 2;
    }
    return runSelftest(io);
  }

  const ringsRoot = ringsRootArg
    ? path.resolve(ringsRootArg)
    : defaultRingsRoot();
  io.out("rings root: " + ringsRoot);
  return mode === "record"
    ? runRecord(ringsRoot, onlyRing, io)
    : runCheck(ringsRoot, onlyRing, io);
}

function defaultIo() {
  return { out: (line) => process.stdout.write(line + "\n") };
}

const invokedAsScript =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedAsScript) {
  process.exit(main(process.argv.slice(2), defaultIo()));
}
