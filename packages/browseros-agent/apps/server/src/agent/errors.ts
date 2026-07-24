/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
export class HttpAgentError extends Error {
  constructor(
    message: string,
    public statusCode = 500,
    public code?: string,
  ) {
    super(message)
    this.name = this.constructor.name
    Error.captureStackTrace(this, this.constructor)
  }

  toJSON() {
    return {
      error: {
        name: this.name,
        message: this.message,
        code: this.code,
        statusCode: this.statusCode,
      },
    }
  }
}

export class SessionNotFoundError extends HttpAgentError {
  constructor(public conversationId: string) {
    super(`Session "${conversationId}" not found.`, 404, 'SESSION_NOT_FOUND')
  }
}

export class ConversationBusyError extends HttpAgentError {
  constructor(
    public conversationId: string,
    public activeRunId?: string,
  ) {
    super(
      `Conversation "${conversationId}" already has an active run.`,
      409,
      'CONVERSATION_BUSY',
    )
  }

  override toJSON() {
    return {
      error: {
        name: this.name,
        message: this.message,
        code: this.code,
        statusCode: this.statusCode,
        conversationId: this.conversationId,
        activeRunId: this.activeRunId,
      },
    }
  }
}

export class AgentExecutionError extends HttpAgentError {
  constructor(
    message: string,
    public originalError?: Error,
  ) {
    super(message, 500, 'AGENT_EXECUTION_ERROR')
  }

  override toJSON() {
    return {
      error: {
        name: this.name,
        message: this.message,
        code: this.code,
        statusCode: this.statusCode,
        originalError: this.originalError?.message,
      },
    }
  }
}
