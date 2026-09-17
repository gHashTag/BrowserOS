import type { EvalVariant } from '../suites/resolve-variant'

export interface BuildRunManifestInput {
  runId: string
  suiteId: string
  variant: EvalVariant
  datasetPath: string
  datasetHash?: string
  graders: string[]
  gitSha?: string
  browserosVersion?: string
  startedAt?: string
}

export interface RunManifest {
  runId: string
  suiteId: string
  variant: EvalVariant['publicMetadata']
  dataset: {
    path: string
    hash?: string
  }
  graders: string[]
  gitSha?: string
  browserosVersion?: string
  startedAt: string
}

/** Builds the sanitized run manifest used for reproducibility. */
export function buildRunManifest(input: BuildRunManifestInput): RunManifest {
  return {
    runId: input.runId,
    suiteId: input.suiteId,
    variant: input.variant.publicMetadata,
    dataset: {
      path: input.datasetPath,
      hash: input.datasetHash,
    },
    graders: input.graders,
    gitSha: input.gitSha,
    browserosVersion: input.browserosVersion,
    startedAt: input.startedAt ?? new Date().toISOString(),
  }
}
