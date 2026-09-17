export class OpenClawInvalidAgentNameError extends Error {
  constructor() {
    super(
      'Agent name must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens',
    )
    this.name = 'OpenClawInvalidAgentNameError'
  }
}

export class OpenClawAgentAlreadyExistsError extends Error {
  constructor(agentId: string) {
    super(`Agent "${agentId}" already exists`)
    this.name = 'OpenClawAgentAlreadyExistsError'
  }
}

export class OpenClawAgentNotFoundError extends Error {
  constructor(agentId: string) {
    super(`Agent "${agentId}" not found`)
    this.name = 'OpenClawAgentNotFoundError'
  }
}

export class OpenClawProtectedAgentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OpenClawProtectedAgentError'
  }
}

export class OpenClawSessionNotFoundError extends Error {
  constructor(public readonly sessionKey: string) {
    super(`OpenClaw session not found: ${sessionKey}`)
    this.name = 'OpenClawSessionNotFoundError'
  }
}
