#!/usr/bin/env bun

/**
 * Upload eval runs to R2.
 *
 * Two modes:
 *   bun scripts/upload-run.ts results/browseros-agent-weekly/2026-03-21-1730
 *   bun scripts/upload-run.ts results/browseros-agent-weekly
 */

import {
  loadR2ConfigFromEnv,
  R2Publisher,
} from '../src/publishing/r2-publisher'

async function main(): Promise<void> {
  const inputDir = process.argv[2]
  if (!inputDir) {
    throw new Error(
      'Usage:\n' +
        '  bun scripts/upload-run.ts results/config-name/2026-03-21-1730\n' +
        '  bun scripts/upload-run.ts results/config-name',
    )
  }

  const publisher = new R2Publisher({ config: loadR2ConfigFromEnv() })
  const result = await publisher.publishPath(inputDir)
  for (const run of result.uploadedRuns) {
    console.log(`Uploaded ${run.uploadedFiles} files for ${run.runId}`)
    console.log(run.viewerUrl)
  }
  for (const runId of result.skippedRuns) {
    console.log(`${runId}: already uploaded, skipping`)
  }
  console.log(
    `Done. Uploaded ${result.uploadedRuns.length} run(s), skipped ${result.skippedRuns.length}.`,
  )
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
