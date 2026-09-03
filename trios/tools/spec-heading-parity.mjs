#!/usr/bin/env node
// spec-heading-parity.mjs - the gate for gHashTag/trios#1390.
//
// QueenSpecQuality.swift states the headings that open a success-criteria
// section twice: once inline in the met: expression of the "success
// criteria" Check, which the judge decides with, and once in
// criteriaHeadings, which the criteria extractor reads with. The two lists
// drifted apart: the inline one never learned the legacy comma spelling of
// the done-when heading, so the judge reported "missing success criteria"
// for nine issues whose criteria section the extractor had just read four
// criteria out of.
//
// This tool holds no copy of either list. It parses both out of the Swift
// source text, computes which criteriaHeadings entries the deciding
// expression can never match, and exits 1 while there are any. It also fails
// when the two copies of the file are not byte-identical, which is the
// comparison `make queen-core-sync` performs; this container has no make,
// so the byte comparison lives here too.
//
// All output is ASCII: any heading outside 0x20-0x7e is printed as \uXXXX
// escapes, one escape per UTF-16 code unit, so a terminal with no Cyrillic
// font can still read a failure.
//
// Usage: node trios/tools/spec-heading-parity.mjs
// The two Swift paths are resolved from this file's own location, so the
// command behaves the same whatever the current directory is.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const swiftPaths = [
    path.resolve(here, '..', 'rings', 'SR-00', 'QueenSpecQuality.swift'),
    path.resolve(
        here,
        '..',
        'agent-server',
        'queen-core',
        'Sources',
        'QueenCore',
        'QueenSpecQuality.swift'
    ),
];

function say(line) {
    process.stdout.write(line + '\n');
}

function fail(line) {
    process.stdout.write(line + '\n');
    process.exit(1);
}

function repoRelative(p) {
    return path.relative(repoRoot, p).split(path.sep).join('/');
}

// Every byte printed is 0x20-0x7e plus newline: each code unit outside that
// range becomes a \uXXXX escape.
function toAscii(s) {
    let out = '';
    for (let i = 0; i < s.length; i += 1) {
        const c = s.charCodeAt(i);
        out += c >= 0x20 && c <= 0x7e ? s[i] : '\\u' + c.toString(16).padStart(4, '0');
    }
    return out;
}

// The contents of the balanced (...) or [...] group that opens at
// source[start]. Double-quoted strings are skipped over, so a bracket or
// comma inside a literal cannot end the group.
function balancedSpan(source, start) {
    let depth = 0;
    for (let i = start; i < source.length; i += 1) {
        const c = source[i];
        if (c === '"') {
            i += 1;
            while (i < source.length && source[i] !== '"') {
                if (source[i] === '\\') i += 1;
                i += 1;
            }
        } else if (c === '(' || c === '[') {
            depth += 1;
        } else if (c === ')' || c === ']') {
            depth -= 1;
            if (depth === 0) return source.slice(start + 1, i);
        }
    }
    return null;
}

// Split an argument list on its top-level commas.
function splitTopLevel(s) {
    const parts = [];
    let current = '';
    for (let i = 0; i < s.length; i += 1) {
        const c = s[i];
        if (c === '"') {
            current += c;
            i += 1;
            while (i < s.length && s[i] !== '"') {
                if (s[i] === '\\') {
                    current += s[i];
                    i += 1;
                }
                current += s[i];
                i += 1;
            }
            if (i < s.length) current += s[i];
        } else if (c === '(' || c === '[') {
            current += c;
        } else if (c === ')' || c === ']') {
            current += c;
        } else if (c === ',' && current.includes('(') === false && current.includes('[') === false) {
            parts.push(current);
            current = '';
        } else if (c === ',') {
            current += c;
        } else {
            current += c;
        }
    }
    parts.push(current);
    return parts;
}

// The string literals inside a Swift array literal.
function stringLiterals(source) {
    const out = [];
    const re = /"((?:[^"\\]|\\.)*)"/g;
    for (let m = re.exec(source); m !== null; m = re.exec(source)) out.push(m[1]);
    return out;
}

// criteriaHeadings, read out of its declaration. This is the reader list.
function readCriteriaHeadings(source) {
    const declAt = source.indexOf('static let criteriaHeadings');
    if (declAt < 0) {
        fail('error: criteriaHeadings is not declared in ' + repoRelative(swiftPaths[0]));
    }
    const openBracket = source.indexOf('[', declAt);
    const inside = balancedSpan(source, openBracket);
    if (inside === null) {
        fail('error: the criteriaHeadings array is unbalanced in ' + repoRelative(swiftPaths[0]));
    }
    const headings = stringLiterals(inside);
    if (headings.length === 0) {
        fail('error: criteriaHeadings holds no headings in ' + repoRelative(swiftPaths[0]));
    }
    return headings;
}

// The met: expression of the Check whose name: is "success criteria", read
// between that name and its remedy:, neither of which a heading string in
// this file contains.
function successCriteriaMet(source) {
    const nameAt = source.indexOf('name: "success criteria"');
    if (nameAt < 0) {
        fail('error: no Check named "success criteria" in ' + repoRelative(swiftPaths[0]));
    }
    const metAt = source.indexOf('met:', nameAt);
    const remedyAt = source.indexOf('remedy:', metAt);
    if (metAt < 0 || remedyAt < 0) {
        fail(
            'error: the "success criteria" Check has no met: expression to read in '
                + repoRelative(swiftPaths[0])
        );
    }
    return source.slice(metAt + 'met:'.length, remedyAt);
}

// Every heading the deciding expression can match, read out of its
// hasSection(body, ...) calls. An inline array literal contributes its
// string literals; the bare identifier criteriaHeadings contributes the
// whole reader list, which is the intended end state. Any other identifier
// names a list this tool cannot read, so it is an error - never an empty
// deciding set.
function decidingHeadings(met, readers) {
    const out = [];
    let at = met.indexOf('hasSection');
    while (at >= 0) {
        const openParen = met.indexOf('(', at);
        if (openParen < 0) break;
        const args = balancedSpan(met, openParen);
        if (args === null) {
            fail('error: unbalanced hasSection call in the "success criteria" Check');
        }
        const parts = splitTopLevel(args);
        if (parts.length === 2 && parts[0].trim() === 'body') {
            const arg = parts[1].trim();
            if (arg.startsWith('[')) {
                for (const heading of stringLiterals(arg)) out.push(heading);
            } else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(arg)) {
                if (arg === 'criteriaHeadings') {
                    for (const heading of readers) out.push(heading);
                } else {
                    fail(
                        'error: hasSection in the "success criteria" Check is passed the identifier '
                            + arg
                            + ', not criteriaHeadings - the tool cannot know what that list holds'
                    );
                }
            } else {
                fail(
                    'error: hasSection in the "success criteria" Check is passed an argument the '
                        + 'tool cannot read: '
                        + toAscii(arg)
                );
            }
        }
        at = met.indexOf('hasSection', openParen + 1);
    }
    return out;
}

function lowerDeduped(list) {
    const seen = new Set();
    const out = [];
    for (const heading of list) {
        const key = heading.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            out.push(key);
        }
    }
    return out;
}

// hasSection looks for "## " + heading as a substring of the lowercased
// body, so a reader heading the check does not name is still matched
// whenever one of the check headings is a prefix of it: "## acceptance
// criteria" contains "## acceptance". A reader heading with no such prefix
// in the check can never be matched, and that is the defect this gate
// exists to catch.
function criteriaHeadingParity(checkList, readerList) {
    const check = lowerDeduped(checkList);
    const reader = lowerDeduped(readerList);
    const onlyInReader = reader.filter((h) => !check.includes(h));
    const onlyInCheck = check.filter((h) => !reader.includes(h));
    const unreachable = onlyInReader.filter(
        (h) => !check.some((c) => ('## ' + h).includes('## ' + c))
    );
    return { check, reader, onlyInReader, onlyInCheck, unreachable };
}

const firstCopy = readFileSync(swiftPaths[0]);
const secondCopy = readFileSync(swiftPaths[1]);
if (!firstCopy.equals(secondCopy)) {
    fail(
        'error: the two copies of QueenSpecQuality.swift are not byte-identical:\n  '
            + repoRelative(swiftPaths[0])
            + '\n  '
            + repoRelative(swiftPaths[1])
    );
}

const source = firstCopy.toString('utf8');
const readers = readCriteriaHeadings(source);
const met = successCriteriaMet(source);
const parity = criteriaHeadingParity(decidingHeadings(met, readers), readers);

say('check  headings (' + parity.check.length + '): ' + parity.check.map(toAscii).join(' | '));
say('reader headings (' + parity.reader.length + '): ' + parity.reader.map(toAscii).join(' | '));
say('only in criteriaHeadings: ' + parity.onlyInReader.length);
say('only in the check       : ' + parity.onlyInCheck.length);
say(
    'unreachable by the check: '
        + parity.unreachable.length
        + (parity.unreachable.length > 0
              ? '  ' + parity.unreachable.map(toAscii).join(' ')
              : '')
);
for (const heading of parity.onlyInReader) {
    say('reader heading the check does not name: ' + toAscii(heading));
}
for (const heading of parity.onlyInCheck) {
    say('check heading criteriaHeadings does not list: ' + toAscii(heading));
}

process.exit(
    parity.onlyInReader.length > 0 || parity.onlyInCheck.length > 0 || parity.unreachable.length > 0
        ? 1
        : 0
);
