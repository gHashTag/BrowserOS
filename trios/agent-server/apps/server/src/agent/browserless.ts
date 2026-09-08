/**
 * Was this server started with no browser AT ALL, by configuration?
 *
 * Not the same question as `browser.isCdpConnected()`, and the difference is
 * the whole point. A desktop server whose browser has not come up yet answers
 * false to that one and will answer true a moment later - main.ts retries the
 * connection every 10s for as long as it takes. Refusing it browser tools on
 * that basis would break the product to fix the container.
 *
 * `cdpPort === null` is a different statement: no port was configured, nothing
 * is being retried, and no browser will ever appear. That is the cloud
 * deployment, where main.ts already says so out loud - "No CDP port
 * configured; starting headless."
 *
 * A module-level flag rather than another field threaded through AgentConfig:
 * it is set once at startup, read at session creation, and never changes.
 */
let browserlessByConfiguration = false

export function markBrowserlessByConfiguration(): void {
  browserlessByConfiguration = true
}

export function isBrowserlessByConfiguration(): boolean {
  return browserlessByConfiguration
}
