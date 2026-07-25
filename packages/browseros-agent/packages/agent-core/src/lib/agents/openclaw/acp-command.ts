/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { OPENCLAW_GATEWAY_CONTAINER_PORT } from '@browseros/shared/constants/openclaw'

/**
 * Live-getter access to the OpenClaw gateway runtime info. Required
 * when spawning the OpenClaw ACP adapter inside the gateway container.
 *
 * Fields are getters (not snapshot values) so the harness picks up the
 * current VM/container paths at spawn time. The bundled gateway runs
 * with `gateway.auth.mode=none`, so no auth token is plumbed through.
 */
export interface OpenclawGatewayAccessor {
  /** Container name e.g. browseros-openclaw-openclaw-gateway-1. */
  getContainerName(): string
  /** LIMA_HOME directory containing the browseros-vm instance. */
  getLimaHomeDir(): string
  /** Resolved path to the `limactl` binary (bundled or host). */
  getLimactlPath(): string
  /** VM name registered in LIMA_HOME (e.g. browseros-vm). */
  getVmName(): string
}

/**
 * Builds the command string acpx will spawn for an `openclaw` adapter.
 * Runs `openclaw acp` inside the gateway container via the bundled
 * `limactl shell <vm> -- nerdctl exec -i ...` chain so the binary
 * already installed alongside the gateway is reused; BrowserOS does
 * not require a host-side OpenClaw install.
 *
 * Auth: BrowserOS configures the bundled gateway with `gateway.auth.mode=none`,
 * so no gateway token flag is needed for the local ACP bridge.
 *
 * Banner output: OPENCLAW_HIDE_BANNER and OPENCLAW_SUPPRESS_NOTES
 * suppress non-JSON-RPC chatter on stdout that would otherwise corrupt
 * the ACP message stream.
 */
export function resolveOpenclawAcpCommand(
  gateway: OpenclawGatewayAccessor,
  sessionKey: string | null,
): string {
  const limactl = gateway.getLimactlPath()
  const vm = gateway.getVmName()
  const container = gateway.getContainerName()
  const limaHome = gateway.getLimaHomeDir()
  const gatewayUrlInsideContainer = `ws://127.0.0.1:${OPENCLAW_GATEWAY_CONTAINER_PORT}`

  // `--session <key>` routes the bridge's newSession requests to the
  // matching gateway agent. acpx does not pass sessionKey through ACP
  // newSession params, so without this CLI flag the bridge falls back
  // to a synthetic acp:<uuid> session that does not resolve to any
  // provisioned gateway agent.
  //
  // Harness keys are `agent:<harness-id>:main`; the harness id matches
  // a dual-created gateway agent name, so the bridge resolves directly.
  // Any legacy non-agent key falls back to the always-provisioned
  // `main` gateway agent with the original key encoded as a channel
  // suffix.
  const bridgeSessionKey = sessionKey
    ? sessionKey.startsWith('agent:')
      ? sessionKey
      : `agent:main:${sessionKey.replace(/[^a-zA-Z0-9-]/g, '-')}`
    : null

  // Prefix `env LIMA_HOME=<path>` so the spawned limactl finds the
  // BrowserOS-owned VM instance. The BrowserOS server doesn't set
  // LIMA_HOME on its own process env (it injects per-spawn elsewhere),
  // so the acpx-spawned subprocess won't inherit it without this hint.
  const argv = [
    'env',
    `LIMA_HOME=${limaHome}`,
    limactl,
    'shell',
    '--workdir',
    '/',
    vm,
    '--',
    'nerdctl',
    'exec',
    '-i',
    '-e',
    'OPENCLAW_HIDE_BANNER=1',
    '-e',
    'OPENCLAW_SUPPRESS_NOTES=1',
    container,
    'openclaw',
    'acp',
    '--url',
    gatewayUrlInsideContainer,
  ]
  if (bridgeSessionKey) {
    argv.push('--session', bridgeSessionKey)
  }
  return argv.join(' ')
}
