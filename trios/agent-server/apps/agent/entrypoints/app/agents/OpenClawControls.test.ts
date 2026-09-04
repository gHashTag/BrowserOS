/**
 * First contract suite for OpenClawControls.tsx.
 *
 * Every export of the subject is exercised by an assertion below, and every
 * test name begins with the export it covers so assertions map to exports.
 * No export needed a live dependency to be exercised, so there is no
 * blocked-export list in this file; the number of tests and the number of
 * blocked exports therefore sum to the six exports of the subject.
 *
 * Rendering uses react-dom/server's renderToStaticMarkup: the components are
 * pure presentational functions of their props, and the string they emit is
 * their observable contract (text, roles, attributes, disabled state,
 * presence and absence of controls). This needs no DOM implementation, no
 * network, no database and no container. Pointer-driven interaction - opening
 * the Radix select popup, clicking a button - is out of scope for the suite
 * as a whole, not for any one export, because this tree's test setup ships no
 * DOM implementation; handler invocation is covered by wiring assertions on
 * the rendered controls instead.
 */
import { describe, expect, it } from 'bun:test'
import type { ReactElement } from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ProviderOption } from './agents-page-types'
import {
  AgentsPageHeader,
  ControlPlaneAlert,
  GatewayStateCards,
  InlineErrorAlert,
  LifecycleAlert,
  ProviderSelector,
} from './OpenClawControls'
import type { OpenClawStatus } from './useOpenClaw'

/** Renders one of the subject's components to its static markup. */
function render(element: ReactElement): string {
  return renderToStaticMarkup(element)
}

/**
 * Counts how many buttons in the markup carry the boolean disabled attribute.
 * React renders that attribute as `disabled=""`, which no Tailwind class in
 * these components (`disabled:opacity-50` and friends) can collide with.
 */
function countDisabledButtons(html: string): number {
  return (html.match(/<button[^>]*\sdisabled=""/g) ?? []).length
}

/** A full, valid gateway status, with the fields under test overridden. */
function makeStatus(overrides: Partial<OpenClawStatus>): OpenClawStatus {
  return {
    status: 'running',
    podmanAvailable: true,
    machineReady: true,
    port: 9105,
    agentCount: 0,
    error: null,
    controlPlaneStatus: 'connected',
    lastGatewayError: null,
    lastRecoveryReason: null,
    ...overrides,
  }
}

const headerCallbacks = {
  onCreateAgent: () => {},
  onOpenTerminal: () => {},
  onReconnect: () => {},
  onRefresh: () => {},
  onRestart: () => {},
  onStop: () => {},
}

const providers: ProviderOption[] = [
  { id: 'p-openai', type: 'openai', name: 'OpenAI', modelId: 'gpt-5.5' },
  {
    id: 'p-anthropic',
    type: 'anthropic',
    name: 'Anthropic',
    modelId: 'sonnet',
  },
]

describe('OpenClawControlsTsxContract', () => {
  it('ProviderSelector: empty state points at AI settings; configured state wires label to combobox and shows the key hint unless told not to', () => {
    const empty = render(
      createElement(ProviderSelector, {
        providers: [],
        defaultProviderId: 'p-openai',
        selectedId: 'p-openai',
        onSelect: () => {},
      }),
    )
    expect(empty).toContain('No compatible LLM providers configured.')
    expect(empty).toContain('Add one in AI settings')
    expect(empty).toContain('href="#/settings/ai"')
    expect(empty).not.toContain('role="combobox"')
    expect(empty).not.toContain('Uses your existing API key')

    const configured = render(
      createElement(ProviderSelector, {
        providers,
        defaultProviderId: 'p-openai',
        selectedId: 'p-anthropic',
        onSelect: () => {},
      }),
    )
    expect(configured).toContain('LLM Provider')
    expect(configured).toContain('for="provider-select"')
    expect(configured).toContain('id="provider-select"')
    expect(configured).toContain('role="combobox"')
    expect(configured).toContain(
      'Uses your existing API key from BrowserOS settings.',
    )

    const hidden = render(
      createElement(ProviderSelector, {
        providers,
        defaultProviderId: 'p-openai',
        selectedId: 'p-openai',
        onSelect: () => {},
        hideApiKeyHint: true,
      }),
    )
    expect(hidden).toContain('role="combobox"')
    expect(hidden).not.toContain('Uses your existing API key')
  })

  it('AgentsPageHeader: badges and gateway controls follow status; running-but-disconnected offers retry; busy flags disable controls', () => {
    const idle = render(
      createElement(AgentsPageHeader, {
        actionInProgress: false,
        controlPlaneBusy: false,
        reconnecting: false,
        status: null,
        ...headerCallbacks,
      }),
    )
    expect(idle).toContain('Agents')
    expect(idle).toContain('OpenClaw, Claude Code, and Codex agents')
    expect(idle).toContain('New Agent')
    expect(idle).toContain('title="Refresh"')
    expect(idle).not.toContain('Retry Connection')
    expect(idle).not.toContain('Terminal')
    expect(idle).not.toContain('Not Set Up')
    expect(countDisabledButtons(idle)).toBe(0)

    const degraded = render(
      createElement(AgentsPageHeader, {
        actionInProgress: false,
        controlPlaneBusy: false,
        reconnecting: false,
        status: makeStatus({ controlPlaneStatus: 'disconnected' }),
        ...headerCallbacks,
      }),
    )
    expect(degraded).toContain('Running')
    expect(degraded).toContain('Disconnected')
    expect(degraded).toContain('Retry Connection')
    expect(degraded).toContain('Terminal')
    expect(degraded).toContain('title="Restart gateway"')
    expect(degraded).toContain('title="Stop gateway"')
    expect(degraded).not.toContain('animate-spin')
    expect(countDisabledButtons(degraded)).toBe(0)

    const connected = render(
      createElement(AgentsPageHeader, {
        actionInProgress: false,
        controlPlaneBusy: false,
        reconnecting: false,
        status: makeStatus({ controlPlaneStatus: 'connected' }),
        ...headerCallbacks,
      }),
    )
    expect(connected).toContain('Control Plane Ready')
    expect(connected).not.toContain('Retry Connection')

    const fresh = render(
      createElement(AgentsPageHeader, {
        actionInProgress: false,
        controlPlaneBusy: false,
        reconnecting: false,
        status: makeStatus({ status: 'uninitialized' }),
        ...headerCallbacks,
      }),
    )
    expect(fresh).toContain('Not Set Up')
    expect(fresh).not.toContain('Control Plane Ready')
    expect(fresh).not.toContain('Terminal')
    expect(fresh).not.toContain('title="Restart gateway"')

    const busy = render(
      createElement(AgentsPageHeader, {
        actionInProgress: true,
        controlPlaneBusy: false,
        reconnecting: false,
        status: makeStatus({ controlPlaneStatus: 'disconnected' }),
        ...headerCallbacks,
      }),
    )
    // Retry, Restart and Stop gate on the in-flight flag; Terminal, Refresh
    // and New Agent stay available.
    expect(countDisabledButtons(busy)).toBe(3)

    const planeBusy = render(
      createElement(AgentsPageHeader, {
        actionInProgress: false,
        controlPlaneBusy: true,
        reconnecting: false,
        status: makeStatus({ controlPlaneStatus: 'disconnected' }),
        ...headerCallbacks,
      }),
    )
    // A busy control plane only disables the retry affordance.
    expect(countDisabledButtons(planeBusy)).toBe(1)

    const retrying = render(
      createElement(AgentsPageHeader, {
        actionInProgress: false,
        controlPlaneBusy: false,
        reconnecting: true,
        status: makeStatus({ controlPlaneStatus: 'disconnected' }),
        ...headerCallbacks,
      }),
    )
    expect(retrying).toContain('animate-spin')
  })

  it('LifecycleAlert: announces the in-flight action in an alert region with a busy spinner', () => {
    const html = render(
      createElement(LifecycleAlert, { message: 'Restarting gateway...' }),
    )
    expect(html).toContain('role="alert"')
    expect(html).toContain('Restarting gateway...')
    expect(html).toContain('animate-spin')
  })

  it('InlineErrorAlert: surfaces the failure copy with destructive styling and a Dismiss control', () => {
    const html = render(
      createElement(InlineErrorAlert, {
        message: 'Podman socket vanished mid-start',
        onDismiss: () => {},
      }),
    )
    expect(html).toContain('role="alert"')
    expect(html).toContain('Agent action failed')
    expect(html).toContain('Podman socket vanished mid-start')
    expect(html).toContain('text-destructive')
    expect(html).toContain('Dismiss')
  })

  it('ControlPlaneAlert: severity, copy and recovery detail follow control-plane state; retry and restart disable while busy', () => {
    const copy = {
      badgeVariant: 'destructive' as const,
      badgeLabel: 'Needs Attention',
      title: 'Gateway Recovery Failed',
      description: 'BrowserOS could not restore the control channel.',
    }
    const failed = render(
      createElement(ControlPlaneAlert, {
        actionInProgress: false,
        controlPlaneBusy: false,
        controlPlaneCopy: copy,
        reconnecting: false,
        recoveryDetail: 'Automatic recovery attempt 2 of 3 is running.',
        status: makeStatus({ controlPlaneStatus: 'failed' }),
        onReconnect: () => {},
        onRestart: () => {},
      }),
    )
    expect(failed).toContain('Gateway Recovery Failed')
    expect(failed).toContain('BrowserOS could not restore the control channel.')
    expect(failed).toContain('Automatic recovery attempt 2 of 3 is running.')
    expect(failed).toContain('text-destructive')
    expect(failed).toContain('lucide-shield-alert')
    expect(failed).toContain('Retry Connection')
    expect(failed).toContain('Restart Gateway')
    expect(failed).not.toContain('animate-spin')
    expect(countDisabledButtons(failed)).toBe(0)

    const recovering = render(
      createElement(ControlPlaneAlert, {
        actionInProgress: false,
        controlPlaneBusy: false,
        controlPlaneCopy: copy,
        reconnecting: false,
        recoveryDetail: null,
        status: makeStatus({ controlPlaneStatus: 'recovering' }),
        onReconnect: () => {},
        onRestart: () => {},
      }),
    )
    expect(recovering).toContain('lucide-wrench')
    expect(recovering).not.toContain('text-destructive')
    expect(recovering).not.toContain('Automatic recovery attempt 2 of 3')

    const offline = render(
      createElement(ControlPlaneAlert, {
        actionInProgress: false,
        controlPlaneBusy: false,
        controlPlaneCopy: copy,
        reconnecting: false,
        recoveryDetail: null,
        status: makeStatus({ controlPlaneStatus: 'disconnected' }),
        onReconnect: () => {},
        onRestart: () => {},
      }),
    )
    expect(offline).toContain('lucide-wifi-off')
    expect(offline).not.toContain('lucide-shield-alert')

    const busy = render(
      createElement(ControlPlaneAlert, {
        actionInProgress: true,
        controlPlaneBusy: true,
        controlPlaneCopy: copy,
        reconnecting: false,
        recoveryDetail: null,
        status: makeStatus({ controlPlaneStatus: 'failed' }),
        onReconnect: () => {},
        onRestart: () => {},
      }),
    )
    // Both recovery controls gate on the busy flags.
    expect(countDisabledButtons(busy)).toBe(2)

    const retrying = render(
      createElement(ControlPlaneAlert, {
        actionInProgress: false,
        controlPlaneBusy: false,
        controlPlaneCopy: copy,
        reconnecting: true,
        recoveryDetail: null,
        status: makeStatus({ controlPlaneStatus: 'failed' }),
        onReconnect: () => {},
        onRestart: () => {},
      }),
    )
    expect(retrying).toContain('animate-spin')
  })

  it('GatewayStateCards: renders one card per gateway state, gating setup on podman availability and actions on in-flight work', () => {
    const idle = render(
      createElement(GatewayStateCards, {
        actionInProgress: false,
        status: null,
        onOpenSetup: () => {},
        onRestart: () => {},
        onStart: () => {},
      }),
    )
    expect(idle).toBe('')

    const setup = render(
      createElement(GatewayStateCards, {
        actionInProgress: false,
        status: makeStatus({ status: 'uninitialized', podmanAvailable: true }),
        onOpenSetup: () => {},
        onRestart: () => {},
        onStart: () => {},
      }),
    )
    expect(setup).toContain('Set Up OpenClaw')
    expect(setup).toContain('Set Up Now')
    expect(setup).toContain(
      'Create a local BrowserOS VM to run autonomous agents with full tool access.',
    )

    const noRuntime = render(
      createElement(GatewayStateCards, {
        actionInProgress: false,
        status: makeStatus({ status: 'uninitialized', podmanAvailable: false }),
        onOpenSetup: () => {},
        onRestart: () => {},
        onStart: () => {},
      }),
    )
    expect(noRuntime).toContain(
      'BrowserOS VM runtime is unavailable on this system.',
    )
    expect(noRuntime).not.toContain('Set Up Now')

    const stopped = render(
      createElement(GatewayStateCards, {
        actionInProgress: false,
        status: makeStatus({ status: 'stopped' }),
        onOpenSetup: () => {},
        onRestart: () => {},
        onStart: () => {},
      }),
    )
    expect(stopped).toContain('Gateway Stopped')
    expect(stopped).toContain('The OpenClaw gateway is not running.')
    expect(stopped).toContain('Start Gateway')
    expect(stopped).not.toContain('Gateway Error')
    expect(stopped).not.toContain('Set Up OpenClaw')
    expect(countDisabledButtons(stopped)).toBe(0)

    const stoppedBusy = render(
      createElement(GatewayStateCards, {
        actionInProgress: true,
        status: makeStatus({ status: 'stopped' }),
        onOpenSetup: () => {},
        onRestart: () => {},
        onStart: () => {},
      }),
    )
    expect(countDisabledButtons(stoppedBusy)).toBe(1)

    const errored = render(
      createElement(GatewayStateCards, {
        actionInProgress: false,
        status: makeStatus({
          status: 'error',
          error: 'podman machine blew up',
          lastGatewayError: 'earlier gateway crash',
        }),
        onOpenSetup: () => {},
        onRestart: () => {},
        onStart: () => {},
      }),
    )
    expect(errored).toContain('Gateway Error')
    expect(errored).toContain('podman machine blew up')
    expect(errored).not.toContain('earlier gateway crash')
    expect(errored).toContain('Start Gateway')
    expect(errored).toContain('Restart Gateway')

    const fallback = render(
      createElement(GatewayStateCards, {
        actionInProgress: false,
        status: makeStatus({
          status: 'error',
          error: null,
          lastGatewayError: 'earlier gateway crash',
        }),
        onOpenSetup: () => {},
        onRestart: () => {},
        onStart: () => {},
      }),
    )
    expect(fallback).toContain('earlier gateway crash')
  })
})
