// Gate for the connectivity vocabulary shared by the Queen worker runner
// and the chat view model.
//
// The rule it guards is written twice in Swift, and the two copies drifted:
// one copy grew a needle the other never received, and neither copy
// recognises the wording the production transport itself renders when the
// network drops. This tool reads the vocabulary from the Swift sources at
// run time and holds three rules:
//
//   1. needle-superset - every needle the view model carries must also be
//      carried by the runner, so the two copies cannot drift apart again.
//   2. transport-case-covered - the TransportError case the transport
//      throws at its URLError erasure sites must render a description
//      that at least one runner needle matches.
//   3. instrument-not-ahead-of-transport - a test instrument whose wording
//      the runner recognises while the transport's own wording goes
//      unrecognised is the defect, not the proof.
//
// The tool is read-only: it reads three Swift files, prints what it found,
// and exits non-zero when a rule does not hold or a source, function body
// or description cannot be found. No needle, case name or description is
// spelled out in this file - a gate carrying a copy of the vocabulary it
// checks would be a third copy that can drift.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The Swift files are resolved from this tool's own location, so the check
// is independent of the working directory it is invoked from.
const toolDir = dirname(fileURLToPath(import.meta.url));
const runnerPath = join(toolDir, '..', 'rings', 'SR-02', 'QueenWorkerRunner.swift');
const viewModelPath = join(toolDir, '..', 'rings', 'SR-02', 'ChatViewModel.swift');
const transportPath = join(toolDir, '..', 'rings', 'SR-01', 'SSETransport.swift');

const runnerLabel = 'trios/rings/SR-02/QueenWorkerRunner.swift';
const viewModelLabel = 'trios/rings/SR-02/ChatViewModel.swift';
const transportLabel = 'trios/rings/SR-01/SSETransport.swift';

let ruleFailures = 0;

function fail(message) {
  ruleFailures += 1;
  console.log(`FAIL: ${message}`);
}

function readSource(path, label) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    fail(`${label} could not be read (${error.message})`);
    return null;
  }
}

// Returns the index of the brace that closes the brace at openIndex,
// or -1 if the text ends first.
function matchBrace(text, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    if (text[i] === '{') {
      depth += 1;
    } else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Takes Swift source text and returns the needles its connectivity
// predicate tests messages against, in source order. Returns null when
// the function or its body cannot be found.
export function connectivityNeedles(swiftSource) {
  if (typeof swiftSource !== 'string') return null;
  const signature = swiftSource.search(/static\s+func\s+isConnectivityFailure\b/);
  if (signature < 0) return null;
  const open = swiftSource.indexOf('{', signature);
  if (open < 0) return null;
  const close = matchBrace(swiftSource, open);
  if (close < 0) return null;
  const body = swiftSource.slice(open, close);
  const needles = [];
  const contains = /lowercased\.contains\("([^"]+)"\)/g;
  let match;
  while ((match = contains.exec(body)) !== null) {
    needles.push(match[1]);
  }
  return needles;
}

// Finds every catch that erases a URLError into a TransportError case and
// reports how many such sites exist plus the case names they throw.
function urlErrorErasure(transportSource) {
  const caseNames = [];
  let siteCount = 0;
  const sites = /catch\s+is\s+URLError\s*\{/g;
  let site;
  while ((site = sites.exec(transportSource)) !== null) {
    siteCount += 1;
    const open = site.index + site.length - 1;
    const close = matchBrace(transportSource, open);
    if (close < 0) continue;
    const block = transportSource.slice(open, close + 1);
    const thrown = /throw\s+TransportError\.([A-Za-z]+)/g;
    let thrownCase;
    while ((thrownCase = thrown.exec(block)) !== null) {
      if (!caseNames.includes(thrownCase[1])) {
        caseNames.push(thrownCase[1]);
      }
    }
  }
  return { siteCount, caseNames };
}

// Reads the wording a TransportError case renders, from the enum's
// description property. Returns null when it cannot be found.
function transportCaseDescription(transportSource, caseName) {
  const property = transportSource.search(/var\s+description:\s*String\s*\{/);
  if (property < 0) return null;
  const open = transportSource.indexOf('{', property);
  if (open < 0) return null;
  const close = matchBrace(transportSource, open);
  if (close < 0) return null;
  const block = transportSource.slice(open, close);
  const rendered = block.match(
    new RegExp(
      `case\\s+\\.${caseName}\\s*(?:\\([^)]*\\))?\\s*:\\s*return\\s+"([^"]+)"`,
    ),
  );
  return rendered ? rendered[1] : null;
}

// Reads the wording the e2e instrument in the runner renders for its
// thrown error. Returns null when it cannot be found.
function instrumentDescription(runnerSource) {
  const rendered = runnerSource.match(
    /var\s+errorDescription:\s*String\?\s*\{\s*"([^"]+)"/,
  );
  return rendered ? rendered[1] : null;
}

const coveredBy = (needles, description) =>
  needles.some((needle) => description.toLowerCase().includes(needle));

const runnerSource = readSource(runnerPath, runnerLabel);
const viewModelSource = readSource(viewModelPath, viewModelLabel);
const transportSource = readSource(transportPath, transportLabel);

const runnerNeedles = runnerSource === null ? null : connectivityNeedles(runnerSource);
const viewModelNeedles =
  viewModelSource === null ? null : connectivityNeedles(viewModelSource);

if (runnerSource !== null && runnerNeedles === null) {
  fail(`${runnerLabel}: the body of the connectivity predicate was not found`);
}
if (viewModelSource !== null && viewModelNeedles === null) {
  fail(`${viewModelLabel}: the body of the connectivity predicate was not found`);
}

const erasure = transportSource === null ? null : urlErrorErasure(transportSource);
if (transportSource !== null && erasure.siteCount === 0) {
  fail(`${transportLabel}: no URLError erasure site was found, so the covered case could not be discovered`);
} else if (transportSource !== null && erasure.caseNames.length === 0) {
  fail(`${transportLabel}: the URLError erasure sites throw no TransportError case`);
}

const describedCases = [];
if (transportSource !== null) {
  for (const caseName of erasure.caseNames) {
    const description = transportCaseDescription(transportSource, caseName);
    if (description === null) {
      fail(`${transportLabel}: no rendered description found for TransportError.${caseName}`);
    }
    describedCases.push({ caseName, description });
  }
}

const instrument =
  runnerSource === null ? null : instrumentDescription(runnerSource);
if (runnerSource !== null && instrument === null) {
  fail(`${runnerLabel}: the e2e instrument error wording was not found`);
}

console.log(
  `RUNNER NEEDLES: ${
    runnerNeedles === null ? '(predicate not found)' : runnerNeedles.join(' | ')
  }`,
);
console.log(
  `VIEWMODEL NEEDLES: ${
    viewModelNeedles === null ? '(predicate not found)' : viewModelNeedles.join(' | ')
  }`,
);
console.log(
  `URLERROR ERASURE SITES: ${
    erasure === null ? 0 : erasure.siteCount
  }`,
);
console.log(
  `TRANSPORT DESCRIPTION ${
    describedCases.length === 0
      ? '(no case found)'
      : describedCases
          .map((entry) => `TransportError.${entry.caseName} = "${entry.description}"`)
          .join('; ')
  }`,
);
console.log(
  `INSTRUMENT DESCRIPTION ${instrument === null ? '(not found)' : `"${instrument}"`}`,
);

// Rule 1: the runner must carry every needle the view model carries.
if (runnerNeedles !== null && viewModelNeedles !== null) {
  const missing = viewModelNeedles.filter(
    (needle) => !runnerNeedles.includes(needle),
  );
  if (missing.length > 0) {
    fail(
      `needle-superset ${missing
        .map((needle) => `"${needle}"`)
        .join(', ')} present in ${viewModelLabel} but absent from ${runnerLabel}`,
    );
  }
}

// Rule 2: the case thrown where a URLError is erased must render wording
// that at least one runner needle matches.
const uncoveredByRunner = [];
if (runnerNeedles !== null) {
  for (const entry of describedCases) {
    if (entry.description === null) continue;
    if (!coveredBy(runnerNeedles, entry.description)) {
      uncoveredByRunner.push(entry);
      fail(
        `transport-case-covered TransportError.${entry.caseName} renders "${entry.description}" and no runner needle matches it`,
      );
    }
  }
}

// Rule 3: the instrument must never be easier to recognise than the
// transport it stands in for.
if (
  runnerNeedles !== null &&
  instrument !== null &&
  uncoveredByRunner.length > 0 &&
  coveredBy(runnerNeedles, instrument)
) {
  fail(
    `instrument-not-ahead-of-transport "${instrument}" is matched by runner needles while ${uncoveredByRunner
      .map((entry) => `"${entry.description}"`)
      .join(', ')} is not`,
  );
}

// The view model is outside this boundary: its own gap is reported, not
// fixed here. Open issue #1133 holds that file.
if (viewModelNeedles !== null) {
  const uncoveredByViewModel = describedCases.filter(
    (entry) =>
      entry.description !== null && !coveredBy(viewModelNeedles, entry.description),
  );
  if (uncoveredByViewModel.length > 0) {
    console.log(
      `OUT OF BOUNDARY: ${viewModelLabel} does not cover ${uncoveredByViewModel
        .map((entry) => `"${entry.description}"`)
        .join(', ')} either; that file is held by open issue #1133 and is not this change's to edit`,
    );
  }
}

process.exitCode = ruleFailures > 0 ? 1 : 0;
