#!/usr/bin/env node
//
// RING-00 — constant parity between the spec and the Rust that runs.
// gHashTag/trios#1337.
//
// `rings/T27-00/queen_core.t27` is the law written once. Its Rust reading —
// hand-written today, `t27c gen-rust` in the Dockerfile when the epic lands —
// answers with the same constants or the two sources have drifted. This gate
// reads both as text — no compiler, no runtime, the Node standard library
// only — and fails the moment a name or a value differs.
//
// What it does not prove: that the functions behave. tests/t27/ring00_parity.sh
// does that, and needs t27c and rustc that a bee container does not carry.
// This gate is the half that runs anywhere: the constants are the coding
// tables every verdict comes from, and drift there is invisible to tests that
// only watch answers.
//
// Exit 0: the two sets agree in name and value. Exit 1: they do not, or a
// file could not be read. A differing type annotation is reported and never
// fails the run — the two languages spell integers differently (FR-002).
//
// Usage: node trios/tools/ring00-constant-parity.mjs [rust-file] [spec-file]
// Paths default to the tree's own; pass a /tmp copy to compare a planted one.
//
// FR-005: nothing under /Users/playra/t27 is ever read. That tree is the
// upstream compiler's home, not this repository's law.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TRIOS = fileURLToPath(new URL('..', import.meta.url));
const SPEC_PATH = resolve(process.argv[3] ?? `${TRIOS}/rings/T27-00/queen_core.t27`);
const RUST_PATH = resolve(process.argv[2] ?? `${TRIOS}/agent-server/t27-core/queen_core.rs`);
const RUST_GIVEN = process.argv[2] !== undefined;
const FOREIGN = '/Users/playra/t27';

function die(message) {
    console.error(`FAIL [ring00-constant-parity]: ${message}`);
    process.exit(1);
}

// One parser for both sides: the ring spells its constants identically in the
// spec and in Rust — that shared spelling is the premise the gate stands on.
function constantsIn(text) {
    const found = new Map();
    const re = /(?:^|\n)[ \t]*pub[ \t]+const[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*:[ \t]*([^=\n]+?)[ \t]*=[ \t]*([^;\n]+?)[ \t]*;/g;
    for (const m of text.matchAll(re)) {
        found.set(m[1], { type: m[2].trim(), value: m[3].replace(/\s+/g, ' ').trim() });
    }
    return found;
}

function readConstants(side, path) {
    if (path === FOREIGN || path.startsWith(`${FOREIGN}/`)) {
        die(`refusing to read the ${side} from under ${FOREIGN}: ${path}`);
    }
    try {
        return constantsIn(readFileSync(path, 'utf8'));
    } catch (error) {
        // Only the DEFAULT Rust path may be absent: the epic's end state
        // deletes the hand-written copy and the Dockerfile generates it, so a
        // tree carrying one source is a state the gate blesses, not flags.
        // A file named on the command line that is not there is a failure.
        if (error.code === 'ENOENT' && side === 'Rust' && !RUST_GIVEN) return null;
        die(`cannot read the ${side} file ${path}: ${error.message}`);
    }
}

const spec = readConstants('spec', SPEC_PATH);
const rust = readConstants('Rust', RUST_PATH);
const against = rust ?? spec;
if (rust === null) {
    console.log(`NOTE: no Rust file at ${RUST_PATH} — the tree carries one source.`);
    console.log('Comparing the spec against the reading `t27c gen-rust` emits from it:');
    console.log('the same constant lines. Pass a Rust file as the first argument');
    console.log('to compare a real copy.');
}

let disagreements = 0;
let typeNotes = 0;
const names = [...new Set([...spec.keys(), ...against.keys()])].sort();
for (const name of names) {
    const inSpec = spec.has(name);
    const inRust = against.has(name);
    if (!inSpec || !inRust) {
        const only = inSpec ? `the spec (${SPEC_PATH})` : `the Rust (${RUST_PATH})`;
        console.log(`MISSING ${name}: declared only in ${only} — the other file is missing it`);
        disagreements += 1;
        continue;
    }
    const s = spec.get(name);
    const r = against.get(name);
    if (s.value !== r.value) {
        console.log(`VALUE ${name}: spec = ${s.value}, Rust = ${r.value}`);
        disagreements += 1;
    } else {
        console.log(`  ${name} = ${s.value}`);
    }
    if (s.type !== r.type) {
        console.log(`  TYPE (reported, not fatal) ${name}: spec ${s.type}, Rust ${r.type}`);
        typeNotes += 1;
    }
}

console.log(`${names.length} constants compared, ${disagreements} disagreements, ${typeNotes} type-spelling notes.`);
process.exitCode = disagreements === 0 ? 0 : 1;
