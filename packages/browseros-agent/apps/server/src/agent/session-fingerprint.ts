import { createHash } from 'node:crypto'
import { AGENT_LIMITS } from '@browseros/shared/constants/limits'
import { LLM_PROVIDERS } from '@browseros/shared/schemas/llm'
import type { AclRule } from '@browseros/shared/types/acl'
import type { AiSdkAgentConfig } from './ai-sdk-agent'
import { getMessageNormalizationOptions } from './message-normalization'

export type SessionExecutionFingerprint = string

type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { readonly [key: string]: CanonicalValue }

const CREDENTIAL_REVISION_DOMAIN = 'browseros/session-credential-revision/v1\0'
const FINGERPRINT_VERSION = 'browseros/session-execution-fingerprint/v1'

function canonicalize(value: CanonicalValue): CanonicalValue {
  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }
  if (value !== null && typeof value === 'object') {
    const canonical: Record<string, CanonicalValue> = Object.create(null)
    for (const key of Object.keys(value).sort()) {
      canonical[key] = canonicalize(value[key])
    }
    return canonical
  }
  return value
}

function optionalString(value: string | undefined): string | null {
  return value ?? null
}

function sortedUnique(values: readonly string[] | undefined): string[] {
  return [...new Set(values ?? [])].sort()
}

function projectAclRules(
  rules: readonly AclRule[] | undefined,
): CanonicalValue[] {
  return (rules ?? []).map((rule) => ({
    id: rule.id,
    sitePattern: rule.sitePattern,
    selector: optionalString(rule.selector),
    textMatch: optionalString(rule.textMatch),
    description: optionalString(rule.description),
    enabled: rule.enabled,
  }))
}

function updateLengthPrefixedUtf8(
  hash: ReturnType<typeof createHash>,
  value: string,
): void {
  const bytes = Buffer.from(value, 'utf8')
  const lengthPrefix = Buffer.alloc(4)
  lengthPrefix.writeUInt32BE(bytes.byteLength)
  hash.update(lengthPrefix)
  hash.update(bytes)
}

function deriveCredentialRevision(
  apiKey: string | undefined,
  secretAccessKey: string | undefined,
  sessionToken: string | undefined,
): string {
  const hash = createHash('sha256')
  hash.update(CREDENTIAL_REVISION_DOMAIN, 'utf8')
  for (const credential of [apiKey, secretAccessKey, sessionToken]) {
    updateLengthPrefixedUtf8(hash, credential ?? '')
  }
  return hash.digest('hex')
}

export function deriveSessionExecutionFingerprint(
  config: AiSdkAgentConfig,
): SessionExecutionFingerprint {
  const {
    accessKeyId,
    accountId,
    apiKey,
    baseUrl,
    browserosId,
    chatMode,
    contextWindowSize,
    evalMode,
    isScheduledTask,
    model,
    origin,
    provider,
    reasoningEffort,
    reasoningSummary,
    region,
    resourceName,
    secretAccessKey,
    sessionToken,
    supportsImages,
    upstreamProvider,
    userSystemPrompt,
    workingDir,
  } = config.resolvedConfig
  const isChatGPTPro = provider === LLM_PROVIDERS.CHATGPT_PRO
  const enabledMcpServers = sortedUnique(
    config.browserContext?.enabledMcpServers,
  )
  const customMcpServers = (config.browserContext?.customMcpServers ?? []).map(
    (server) => ({
      name: server.name,
      url: server.url,
    }),
  )
  const klavisState =
    enabledMcpServers.length === 0
      ? 'disabled'
      : config.klavisRef?.handle
        ? 'connected'
        : 'pending'
  const enabledApprovalCategories = Object.entries(
    config.resolvedConfig.toolApprovalConfig?.categories ?? {},
  )
    .filter(([, enabled]) => enabled === true)
    .map(([category]) => category)
    .sort()
  const normalizationOptions = getMessageNormalizationOptions(
    config.resolvedConfig,
  )
  const safeMaterial = {
    version: FINGERPRINT_VERSION,
    resolvedConfig: {
      provider,
      model,
      baseUrl: optionalString(baseUrl),
      upstreamProvider: optionalString(upstreamProvider),
      resourceName: optionalString(resourceName),
      region: optionalString(region),
      accessKeyId: optionalString(accessKeyId),
      accountId: optionalString(accountId),
      credentialRevision: deriveCredentialRevision(
        apiKey,
        secretAccessKey,
        sessionToken,
      ),
      reasoningEffort: isChatGPTPro
        ? reasoningEffort || 'high'
        : optionalString(reasoningEffort),
      reasoningSummary: isChatGPTPro
        ? reasoningSummary || 'auto'
        : optionalString(reasoningSummary),
      contextWindowSize:
        contextWindowSize ?? AGENT_LIMITS.DEFAULT_CONTEXT_WINDOW,
      userSystemPrompt: optionalString(userSystemPrompt),
      workingDir: optionalString(workingDir),
      supportsImages: supportsImages !== false,
      evalMode: evalMode ?? false,
      chatMode: chatMode ?? false,
      isScheduledTask: isScheduledTask ?? false,
      origin: origin ?? 'sidepanel',
      browserosId: optionalString(browserosId),
      declinedApps: sortedUnique(config.resolvedConfig.declinedApps),
    },
    aiSdkDevtoolsEnabled: config.aiSdkDevtoolsEnabled ?? false,
    registryToolNames: sortedUnique(config.registry.names()),
    browserContext: {
      activePageId: config.browserContext?.activeTab?.pageId ?? null,
      enabledMcpServers,
      customMcpServers,
    },
    klavisState,
    enabledApprovalCategories,
    aclRules: projectAclRules(config.aclRules),
    normalization: {
      supportsImages: normalizationOptions.supportsImages,
      supportsMediaInToolResults:
        normalizationOptions.supportsMediaInToolResults,
    },
  } satisfies CanonicalValue
  const serialized = JSON.stringify(canonicalize(safeMaterial))

  return createHash('sha256').update(serialized, 'utf8').digest('hex')
}
