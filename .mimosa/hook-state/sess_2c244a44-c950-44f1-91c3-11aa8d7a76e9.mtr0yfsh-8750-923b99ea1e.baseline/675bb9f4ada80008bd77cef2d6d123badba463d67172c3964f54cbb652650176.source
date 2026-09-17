/**
 * Resolve environment variable values.
 * If the value looks like an env var name (ALL_CAPS_WITH_UNDERSCORES),
 * resolves it from process.env. Otherwise returns the value as-is.
 */
export function resolveEnvValue(value: string | undefined): string | undefined {
  if (!value) return undefined
  if (/^[A-Z][A-Z0-9_]*$/.test(value)) {
    return process.env[value] ?? value
  }
  return value
}
