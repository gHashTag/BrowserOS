import { logger } from '../../lib/logger'

interface SemanticScore {
  score: number
  backend: string
}

interface EmbeddingOutput {
  tolist: () => number[][]
  dispose?: () => void
}

interface FeatureExtractionPipeline {
  (
    texts: string[],
    options: { pooling: string; normalize: boolean },
  ): Promise<EmbeddingOutput>
  dispose?: () => Promise<void>
}

let pipelineInstance: FeatureExtractionPipeline | null = null
const LOAD_RETRY_MS = 60_000
let lastLoadFailedAt = 0
let cleanupListener: (() => void) | null = null

function getModelName(): string {
  return process.env.ACL_EMBEDDING_MODEL ?? 'Xenova/bge-small-en-v1.5'
}

function isSemanticDisabled(): boolean {
  return process.env.ACL_EMBEDDING_DISABLE === 'true'
}

export async function disposeSemanticPipeline(): Promise<void> {
  const current = pipelineInstance
  pipelineInstance = null
  if (cleanupListener) {
    process.removeListener('beforeExit', cleanupListener)
    cleanupListener = null
  }
  if (!current?.dispose) {
    return
  }

  try {
    await current.dispose()
  } catch (error) {
    logger.warn('ACL embedding model disposal failed', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function registerPipelineCleanup(): void {
  if (cleanupListener) {
    return
  }
  cleanupListener = () => {
    // beforeExit cannot await async cleanup, so explicit disposal is still
    // required anywhere teardown must be deterministic.
    void disposeSemanticPipeline()
  }
  process.once('beforeExit', cleanupListener)
}

async function ensurePipeline(): Promise<FeatureExtractionPipeline | null> {
  if (pipelineInstance) return pipelineInstance
  if (lastLoadFailedAt > 0 && Date.now() - lastLoadFailedAt < LOAD_RETRY_MS) {
    return null
  }

  try {
    const { pipeline } = await import('@huggingface/transformers')
    const extractor = await pipeline('feature-extraction', getModelName(), {
      dtype: 'fp32',
    })
    pipelineInstance = extractor as unknown as FeatureExtractionPipeline
    registerPipelineCleanup()
    lastLoadFailedAt = 0
    logger.info('ACL embedding model loaded', { model: getModelName() })
    return pipelineInstance
  } catch (error) {
    lastLoadFailedAt = Date.now()
    logger.warn(
      'ACL embedding model failed to load, semantic scoring disabled',
      {
        model: getModelName(),
        error: error instanceof Error ? error.message : String(error),
      },
    )
    return null
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

export async function computeSemanticSimilarity(
  left: string,
  right: string,
): Promise<SemanticScore> {
  if (!left || !right) return { score: 0, backend: 'none' }
  if (isSemanticDisabled()) return { score: 0, backend: 'disabled' }

  const extractor = await ensurePipeline()
  if (!extractor) return { score: 0, backend: 'error' }

  try {
    const output = await extractor([left, right], {
      pooling: 'cls',
      normalize: true,
    })
    const embeddings = output.tolist()
    output.dispose?.()
    const score = cosineSimilarity(embeddings[0], embeddings[1])
    return {
      score: Math.max(0, Math.min(score, 1)),
      backend: 'transformers.js',
    }
  } catch (error) {
    logger.warn('ACL semantic similarity computation failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return { score: 0, backend: 'error' }
  }
}
