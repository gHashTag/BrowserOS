import { describe, expect, it } from 'bun:test'
import {
  getOpenClawService,
  peekOpenClawService,
} from '../../src/api/services/openclaw/openclaw-service'

describe('OpenClaw shutdown', () => {
  // The defect: stop() called getOpenClawService(), which constructs on
  // demand, so tearing down CREATED the runtime it meant to stop. On Linux the
  // constructor throws "browseros-vm currently supports macOS only", and
  // because the throw happens before .shutdown() returns a promise, the
  // .catch() beside it caught nothing. Measured on the deployed container:
  // every shutdown ended in a stack trace, after a startup that had already
  // logged "OpenClaw configuration failed, continuing without it".
  it('reports nothing when nothing was started, and never constructs', () => {
    // A fresh module in a fresh test process has no service.
    expect(peekOpenClawService()).toBeNull()
    // Asking twice must still not build one - that is the whole point.
    expect(peekOpenClawService()).toBeNull()
  })

  it('returns the same instance the constructing accessor made', () => {
    let made: ReturnType<typeof getOpenClawService> | null = null
    try {
      made = getOpenClawService()
    } catch {
      // On a platform without a container runtime this throws, which is
      // exactly the case peek exists to avoid on the shutdown path.
      expect(peekOpenClawService()).toBeNull()
      return
    }
    expect(peekOpenClawService()).toBe(made)
  })
})
