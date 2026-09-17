import type { RunCliArgs } from '../args'
import { runSuiteCommand, type SuiteCommandDeps } from './suite'

/** Executes tasks from a config or suite without publishing artifacts. */
export async function runRunCommand(
  args: RunCliArgs,
  deps: SuiteCommandDeps = {},
): Promise<void> {
  await runSuiteCommand(
    {
      configPath: args.configPath,
      suitePath: args.suitePath,
      variantId: args.variantId,
      provider: args.provider,
      model: args.model,
      apiKey: args.apiKey,
      baseUrl: args.baseUrl,
    },
    deps,
  )
}
