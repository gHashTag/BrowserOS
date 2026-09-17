export const HERMES_AGENT_NAME = 'hermes'
export const HERMES_IMAGE = 'docker.io/nousresearch/hermes-agent:v2026.4.30'
export const HERMES_COMPOSE_PROJECT_NAME = 'browseros-hermes'
export const HERMES_CONTAINER_NAME = `${HERMES_COMPOSE_PROJECT_NAME}-hermes-agent-1`
// Inside the container, /data is the volume mount where per-agent HERMES_HOME
// directories live: /data/agents/harness/<agentId>/home. The host-side
// directory that backs this mount lives under the BrowserOS-managed VM
// state directory (so it's reachable inside the Lima VM via the existing
// vm/ mount); the container sees the same files via /data/agents/harness.
export const HERMES_CONTAINER_DATA_DIR = '/data'
export const HERMES_CONTAINER_HARNESS_DIR = `${HERMES_CONTAINER_DATA_DIR}/agents/harness`

/**
 * BrowserOS LLM provider types Hermes can consume. The frontend filters
 * the global provider list to these; the backend `hermes-provider-map`
 * maps them onto Hermes' own provider keys. Keep both sides in sync via
 * this single list — adding a new entry without updating the backend
 * map will cause a 400 at agent-create time.
 *
 * Bedrock is intentionally NOT included yet — it needs multiple env
 * vars (AWS_ACCESS_KEY_ID + secret + region) and a separate UX path.
 */
export const HERMES_SUPPORTED_BROWSEROS_PROVIDER_TYPES = [
  'anthropic',
  'openai',
  'openai-compatible',
  'openrouter',
] as const

export type HermesSupportedBrowserosProviderType =
  (typeof HERMES_SUPPORTED_BROWSEROS_PROVIDER_TYPES)[number]
