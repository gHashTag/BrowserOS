/** @public */
export const trios_PREFS = {
  AGENT_PORT: 'trios.server.agent_port',
  MCP_PORT: 'trios.server.mcp_port',
  PROVIDERS: 'trios.providers',
  THIRD_PARTY_LLM_PROVIDERS: 'trios.third_party_llm.providers',
  PROXY_PORT: 'trios.server.proxy_port',
  SERVER_PORT: 'trios.server.server_port',
  ALLOW_REMOTE_MCP: 'trios.server.allow_remote_in_mcp',
  RESTART_SERVER: 'trios.server.restart_requested',
  SHOW_LLM_CHAT: 'trios.show_llm_chat',
  SHOW_LLM_HUB: 'trios.show_llm_hub',
  SHOW_TOOLBAR_LABELS: 'trios.show_toolbar_labels',
  VERTICAL_TABS_ENABLED: 'trios.vertical_tabs_enabled',
  INSTALL_ID: 'trios.metrics_install_id',
} as const
