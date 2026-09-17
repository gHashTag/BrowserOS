import { publishPathToR2 } from '../../publishing/r2-publisher'
import type { PublishCliArgs, PublishTarget } from '../args'

export interface PublishRunOptions {
  runDir: string
  target: PublishTarget
}

/** Publishes run artifacts through the R2 viewer upload path. */
export async function publishRun(options: PublishRunOptions): Promise<void> {
  if (options.target !== 'r2') {
    throw new Error(`Unsupported publish target: ${options.target}`)
  }
  const result = await publishPathToR2(options.runDir)
  for (const run of result.uploadedRuns) {
    console.log(run.viewerUrl)
  }
  for (const runId of result.skippedRuns) {
    console.log(`${runId}: already uploaded, skipping`)
  }
}

export async function runPublishCommand(args: PublishCliArgs): Promise<void> {
  await publishRun({ runDir: args.runDir, target: args.target })
}
