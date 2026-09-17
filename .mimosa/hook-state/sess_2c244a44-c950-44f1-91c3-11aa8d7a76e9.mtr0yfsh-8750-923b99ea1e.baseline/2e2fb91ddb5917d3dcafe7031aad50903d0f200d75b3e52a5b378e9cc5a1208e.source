import { parseArgs } from 'node:util'

export type PublishTarget = 'r2'

export interface LegacyCliArgs {
  command: 'legacy'
  configPath?: string
  help?: boolean
}

export interface SuiteCliArgs {
  command: 'suite'
  configPath?: string
  suitePath?: string
  variantId?: string
  provider?: string
  model?: string
  apiKey?: string
  baseUrl?: string
  publishTarget?: PublishTarget
}

export interface RunCliArgs
  extends Omit<SuiteCliArgs, 'command' | 'publishTarget'> {
  command: 'run'
}

export interface GradeCliArgs {
  command: 'grade'
  runDir: string
}

export interface PublishCliArgs {
  command: 'publish'
  runDir: string
  target: PublishTarget
}

export type EvalCliArgs =
  | LegacyCliArgs
  | SuiteCliArgs
  | RunCliArgs
  | GradeCliArgs
  | PublishCliArgs

const COMMANDS = new Set(['suite', 'run', 'grade', 'publish'])

function stringValue(value: string | boolean | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function publishTarget(value: string | undefined): PublishTarget | undefined {
  if (value === undefined) return undefined
  if (value === 'r2') return 'r2'
  throw new Error(`Unsupported publish target: ${value}`)
}

function requireOne(
  command: string,
  configPath: string | undefined,
  suitePath: string | undefined,
): void {
  if (!configPath && !suitePath) {
    throw new Error(`${command} requires --config or --suite`)
  }
  if (configPath && suitePath) {
    throw new Error(`${command} accepts either --config or --suite, not both`)
  }
}

function parseSuiteLikeArgs(
  command: 'suite' | 'run',
  argv: string[],
): SuiteCliArgs | RunCliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string' },
      suite: { type: 'string' },
      variant: { type: 'string' },
      provider: { type: 'string' },
      model: { type: 'string' },
      'api-key': { type: 'string' },
      'base-url': { type: 'string' },
      publish: { type: 'string' },
    },
  })

  const configPath = stringValue(values.config)
  const suitePath = stringValue(values.suite)
  requireOne(command, configPath, suitePath)

  const parsed: SuiteCliArgs | RunCliArgs =
    command === 'suite' ? { command: 'suite' } : { command: 'run' }
  if (configPath) parsed.configPath = configPath
  if (suitePath) parsed.suitePath = suitePath
  const variantId = stringValue(values.variant)
  if (variantId) parsed.variantId = variantId
  const provider = stringValue(values.provider)
  if (provider) parsed.provider = provider
  const model = stringValue(values.model)
  if (model) parsed.model = model
  const apiKey = stringValue(values['api-key'])
  if (apiKey) parsed.apiKey = apiKey
  const baseUrl = stringValue(values['base-url'])
  if (baseUrl) parsed.baseUrl = baseUrl

  if (command === 'suite') {
    const target = publishTarget(stringValue(values.publish))
    if (target) {
      const suiteArgs = parsed as SuiteCliArgs
      suiteArgs.publishTarget = target
    }
  }

  return parsed
}

function parseLegacyArgs(argv: string[]): LegacyCliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string', short: 'c' },
      help: { type: 'boolean', short: 'h' },
    },
  })

  const parsed: LegacyCliArgs = { command: 'legacy' }
  const configPath = stringValue(values.config)
  if (configPath) parsed.configPath = configPath
  if (values.help) parsed.help = true
  return parsed
}

/** Parses the eval CLI command without running browser or publishing side effects. */
export function parseEvalCliArgs(argv: string[]): EvalCliArgs {
  const [command, ...rest] = argv
  if (!COMMANDS.has(command ?? '')) {
    return parseLegacyArgs(argv)
  }

  switch (command) {
    case 'suite':
      return parseSuiteLikeArgs('suite', rest)
    case 'run':
      return parseSuiteLikeArgs('run', rest)
    case 'grade': {
      const { values } = parseArgs({
        args: rest,
        options: { run: { type: 'string' } },
      })
      const runDir = stringValue(values.run)
      if (!runDir) throw new Error('grade requires --run')
      return { command: 'grade', runDir }
    }
    case 'publish': {
      const { values } = parseArgs({
        args: rest,
        options: { run: { type: 'string' }, target: { type: 'string' } },
      })
      const runDir = stringValue(values.run)
      if (!runDir) throw new Error('publish requires --run')
      const target = publishTarget(stringValue(values.target))
      if (!target) throw new Error('publish requires --target')
      return { command: 'publish', runDir, target }
    }
    default:
      return parseLegacyArgs(argv)
  }
}
