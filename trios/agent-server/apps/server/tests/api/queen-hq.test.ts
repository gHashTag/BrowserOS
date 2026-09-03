import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Two defects have already been shipped on the queen pages, and both are the
 * kind a reader cannot see. This file holds them shut on the new one.
 *
 * THE LEAK. The board built its legend fresh on every 30-second redraw and
 * spliced it in ahead of a sibling; nothing removed the previous one. The
 * operator's screen carried a hundred and twenty copies of "1 pick an issue ->
 * 2 cut a branch", with the actual board somewhere below them. A drawing
 * function that appends is a leak with a timer on it.
 *
 * THE LEAK OF A DIFFERENT KIND. `/queen/kanban` once served 57 cards and every
 * bee's detail to anyone who found the URL. The rule since: the page is a
 * SHELL with no state in it, and every number arrives from `/queen/board`,
 * which requires the bearer token.
 */

const HQ = join(import.meta.dir, '../../src/api/routes/queen-hq.ts')
const SERVER = join(import.meta.dir, '../../src/api/server.ts')
const source = readFileSync(HQ, 'utf8')

describe('the Queen HQ page', () => {
  it('is mounted where the operator can reach it', () => {
    const server = readFileSync(SERVER, 'utf8')
    expect(server).toContain('createQueenHqRoute')
    expect(server).toContain("'/queen/hq'")
  })

  // Every node draw() writes into must already exist in the shell, and be
  // written by assignment. An insert is how the legend multiplied.
  it('assigns into permanent nodes and never inserts a sibling', () => {
    // The node must exist in the SHELL - that is what makes it permanent.
    for (const id of ['verdict', 'hive', 'flow', 'gauges', 'cols', 'live']) {
      expect(source).toContain(`id="${id}"`)
    }
    // And the rule itself: nothing is ever spliced into the document. An
    // earlier version of this check looked for the literal `$('verdict')
    // .innerHTML` and failed on code that assigns through a local variable -
    // a test that measures the spelling rather than the rule.
    expect(source).not.toContain('insertBefore')
    expect(source).not.toContain('appendChild')
    expect(source).not.toContain('createElement')
  })

  // The shell carries no state. If a card, a count or an issue number were
  // baked into the HTML, the page would publish the swarm to an unauthenticated
  // reader - which is exactly what /queen/kanban did.
  it('carries no state, so an unauthenticated reader learns nothing', () => {
    const shellOnly = source.slice(
      source.indexOf('<!doctype html>'),
      source.indexOf('<script>'),
    )
    // Issue numbers, repository names and model names are the three things
    // that leaked from /queen/kanban. A first version of this check used
    // /#\d{3,}/ and matched the CSS colour #07090c, which is the shape of a
    // test that fails on the page being dark rather than on it being unsafe.
    expect(shellOnly).not.toMatch(/#1[0-9]{3}\b/)
    expect(shellOnly).not.toContain('gHashTag/')
    expect(shellOnly.toLowerCase()).not.toContain('glm-')
    expect(shellOnly).not.toContain('queen-1')
  })

  it('sends the token as a header and never in the URL', () => {
    expect(source).toContain("Authorization:'Bearer '+token")
    expect(source).not.toMatch(/\?token=/)
    expect(source).toContain('never in the URL')
  })

  // The hive draws one cell per slot the swarm could actually fill. Drawing
  // the policy limit while fewer keys exist invites a hunt for bees that were
  // never possible - the operator asked "why is only one working" of a page
  // that showed four slots and one key.
  it('draws the hive against the real ceiling, not the policy limit', () => {
    expect(source).toContain('Math.min(keys||0,limit)')
    expect(source).toContain('no key')
  })

  // The one action. The operator ran a round by hand from a terminal for a
  // whole session; the page exists partly so they do not have to.
  it('offers exactly one action, and it is the round', () => {
    expect(source).toContain("fetch('/queen/lease/tick',{method:'POST'")
    expect(source).toContain('run a round now')
  })
})
