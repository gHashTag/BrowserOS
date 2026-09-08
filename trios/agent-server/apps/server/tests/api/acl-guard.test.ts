import { describe, it } from 'bun:test'
import assert from 'node:assert'
import type { AclRule, ElementProperties } from '@browseros/shared/types/acl'
import type { Browser, PageInfo } from '../../src/browser/browser'
import { checkAcl } from '../../src/tools/acl/acl-guard'

/**
 * Pins the contract of acl-guard.ts as it stands today. The subject is not
 * modified; nothing below asks for one behaviour over another, only for the
 * behaviour the module already has, so the next change to the file fails
 * here first.
 *
 * checkAcl is the module's sole exported symbol and the sole symbol this
 * suite covers, named in the test title below so a reader can map
 * assertions to exports.
 *
 * No export is left unexercised behind a blocked dependency. The module's
 * one runtime dependency is the live browser session, and it touches that
 * session only through three methods - refreshPageInfo,
 * resolveElementAtPoint and resolveElementProperties - which a
 * deterministic stand-in below supplies, so every decision path of the
 * export runs. The stand-in is the whole extent of the substitution: site
 * pattern matching and the fixture scorer run for real. Semantic scoring
 * inside the scorer is disabled below so no embedding model is fetched and
 * no network is touched; the exact and fuzzy paths decide the fixture
 * cases on their own. No database and no container are involved anywhere
 * in this suite.
 */

// The real scorer must not fetch an embedding model during this suite.
process.env.ACL_EMBEDDING_DISABLE = 'true'

const CHECKOUT_URL = 'https://shop.example.com/checkout'

const GUARDED_TOOL_NAMES = [
  'click',
  'click_at',
  'fill',
  'type_at',
  'hover',
  'hover_at',
  'drag',
  'drag_at',
  'focus',
  'clear',
  'check',
  'uncheck',
  'select_option',
  'press_key',
  'upload_file',
]

const UNGUARDED_TOOL_NAMES = [
  'take_snapshot',
  'navigate_page',
  'get_page_content',
]

const siteOnlyRule: AclRule = {
  id: 'shop-is-read-only',
  sitePattern: 'shop.example.com',
  enabled: true,
}

const wrongPathRule: AclRule = {
  id: 'account-page-only',
  sitePattern: 'shop.example.com/account',
  enabled: true,
}

const placeOrderRule: AclRule = {
  id: 'no-placing-orders',
  sitePattern: 'shop.example.com',
  textMatch: 'place order',
  enabled: true,
}

const deleteAccountRule: AclRule = {
  id: 'no-deleting-accounts',
  sitePattern: 'shop.example.com',
  textMatch: 'delete account',
  enabled: true,
}

const placeOrderButton: ElementProperties = {
  tagName: 'button',
  textContent: 'Place Order',
  attributes: { id: 'submit-btn' },
  ariaLabel: 'Place Order',
  role: 'button',
}

const viewReportButton: ElementProperties = {
  tagName: 'button',
  textContent: 'View Report',
  attributes: { id: 'view-report' },
  ariaLabel: 'View Report',
  role: 'button',
}

function pageInfoFor(pageId: number, url: string): PageInfo {
  return {
    pageId,
    targetId: `target-${pageId}`,
    tabId: pageId,
    url,
    title: 'fixture page',
    isActive: true,
    isLoading: false,
    loadProgress: 1,
    isPinned: false,
    isHidden: false,
  }
}

/**
 * A stand-in for the live browser session. The guard reads a page and
 * resolves elements only through the three methods reimplemented here:
 * the page is whatever pageInfo holds, an (x, y) pair names whichever
 * element id that point map records, and an element id carries whichever
 * properties that property map records. Anything absent resolves to
 * "unknown", exactly as a live session answers for a point with nothing
 * actionable beneath it or an element whose properties cannot be read.
 */
interface BrowserPlan {
  pageInfo?: PageInfo
  elementAtPoint?: Record<string, number>
  properties?: Record<number, ElementProperties>
}

function stubBrowser(plan: BrowserPlan = {}): Browser {
  return {
    refreshPageInfo: async () => plan.pageInfo,
    resolveElementAtPoint: async (_pageId: number, x: number, y: number) =>
      plan.elementAtPoint?.[`${x},${y}`] ?? null,
    resolveElementProperties: async (_pageId: number, elementId: number) =>
      plan.properties?.[elementId] ?? null,
  } as unknown as Browser
}

/**
 * A browser that fails loudly the moment the guard touches it. Where the
 * guard is contracted to answer from its arguments alone, the observable
 * fact is that the answer arrives without a browser session at all: had
 * the guard consulted one, the call would have rejected instead of
 * resolving. The assertion stays on the contract - the resolved value -
 * and never inspects the wiring.
 */
function untouchableBrowser(): Browser {
  return {
    refreshPageInfo: async () => {
      throw new Error(
        'checkAcl consulted a browser session it must not need for this call',
      )
    },
  } as unknown as Browser
}

describe('aclGuardContract', () => {
  it('checkAcl: allows unguarded tools, rule-less calls and unjudgeable elements, and blocks guarded tools with the rule, page and element that matched', async () => {
    // Read-only tools pass through untouched, even when a rule would block
    // any guarded tool on the very same page.
    for (const toolName of UNGUARDED_TOOL_NAMES) {
      assert.deepStrictEqual(
        await checkAcl(toolName, { page: 3 }, untouchableBrowser(), [
          siteOnlyRule,
        ]),
        { blocked: false },
        `${toolName} must not be guarded`,
      )
    }

    // No rules means nothing to enforce, decided before any page is read.
    assert.deepStrictEqual(
      await checkAcl('click', { page: 3 }, untouchableBrowser(), []),
      { blocked: false },
      'an empty rule list must leave the call unguarded',
    )

    // A call that names no page cannot be matched to a site, so it stands.
    assert.deepStrictEqual(
      await checkAcl('click', {}, untouchableBrowser(), [siteOnlyRule]),
      { blocked: false },
      'a call without a page id must pass',
    )

    // A page the browser cannot produce has no URL to match rules against.
    assert.deepStrictEqual(
      await checkAcl('click', { page: 99 }, stubBrowser(), [siteOnlyRule]),
      { blocked: false },
      'an unknown page id must pass',
    )

    // Rules scoped to another site never reach the element.
    const inboxBrowser = stubBrowser({
      pageInfo: pageInfoFor(3, 'https://mail.example.com/inbox'),
      properties: { 11: placeOrderButton },
    })
    assert.deepStrictEqual(
      await checkAcl('fill', { page: 3, element: 11 }, inboxBrowser, [
        siteOnlyRule,
        placeOrderRule,
      ]),
      { blocked: false },
      'rules for another site must not block',
    )

    // Rules scoped to another path of the same site do not reach the
    // element either.
    const checkoutBrowser = stubBrowser({
      pageInfo: pageInfoFor(3, CHECKOUT_URL),
      properties: {
        7: placeOrderButton,
        11: placeOrderButton,
        42: placeOrderButton,
        55: placeOrderButton,
      },
      elementAtPoint: { '120,240': 42, '10,20': 55 },
    })
    assert.deepStrictEqual(
      await checkAcl('click', { page: 3, element: 11 }, checkoutBrowser, [
        wrongPathRule,
      ]),
      { blocked: false },
      'a rule scoped to another path must not block',
    )

    // A site-wide rule blocks every guarded tool on that site, naming the
    // rule and the page and nothing else.
    for (const toolName of GUARDED_TOOL_NAMES) {
      assert.deepStrictEqual(
        await checkAcl(toolName, { page: 3, element: 11 }, checkoutBrowser, [
          siteOnlyRule,
        ]),
        { blocked: true, rule: siteOnlyRule, pageId: 3 },
        `${toolName} must be guarded`,
      )
    }

    // An explicit element id names the element to judge.
    assert.deepStrictEqual(
      await checkAcl('click', { page: 3, element: 11 }, checkoutBrowser, [
        placeOrderRule,
      ]),
      { blocked: true, rule: placeOrderRule, pageId: 3, elementId: 11 },
      'an element id must be judged against the rule',
    )

    // When both are given, the explicit element id outranks the
    // coordinates.
    assert.deepStrictEqual(
      await checkAcl(
        'click_at',
        { page: 3, element: 11, x: 120, y: 240 },
        checkoutBrowser,
        [placeOrderRule],
      ),
      { blocked: true, rule: placeOrderRule, pageId: 3, elementId: 11 },
      'the element id must outrank the coordinates',
    )

    // Without an element id, the point names the element: the element
    // beneath (120, 240) is id 42 in the stand-in.
    assert.deepStrictEqual(
      await checkAcl('click', { page: 3, x: 120, y: 240 }, checkoutBrowser, [
        placeOrderRule,
      ]),
      { blocked: true, rule: placeOrderRule, pageId: 3, elementId: 42 },
      'the element beneath the point must be judged',
    )

    // drag is judged at the element being dragged, not at the target.
    assert.deepStrictEqual(
      await checkAcl(
        'drag',
        { page: 3, sourceElement: 7, targetElement: 9 },
        checkoutBrowser,
        [placeOrderRule],
      ),
      { blocked: true, rule: placeOrderRule, pageId: 3, elementId: 7 },
      'drag must be judged at the source element',
    )

    // drag_at is judged at the element beneath the start point.
    assert.deepStrictEqual(
      await checkAcl(
        'drag_at',
        { page: 3, startX: 10, startY: 20, endX: 30, endY: 40 },
        checkoutBrowser,
        [placeOrderRule],
      ),
      { blocked: true, rule: placeOrderRule, pageId: 3, elementId: 55 },
      'drag_at must be judged at the element beneath the start point',
    )

    // A point with nothing actionable beneath it cannot be judged.
    const barePointBrowser = stubBrowser({
      pageInfo: pageInfoFor(3, CHECKOUT_URL),
      elementAtPoint: {},
      properties: {},
    })
    assert.deepStrictEqual(
      await checkAcl('click', { page: 3, x: 1, y: 2 }, barePointBrowser, [
        placeOrderRule,
      ]),
      { blocked: false },
      'a point with no element beneath it must pass',
    )

    // An element whose properties cannot be read cannot be judged.
    assert.deepStrictEqual(
      await checkAcl('click', { page: 3, element: 11 }, barePointBrowser, [
        placeOrderRule,
      ]),
      { blocked: false },
      'an element with unreadable properties must pass',
    )

    // An element no rule describes is allowed to be used.
    const reportBrowser = stubBrowser({
      pageInfo: pageInfoFor(3, CHECKOUT_URL),
      properties: { 11: viewReportButton },
    })
    assert.deepStrictEqual(
      await checkAcl('click', { page: 3, element: 11 }, reportBrowser, [
        placeOrderRule,
      ]),
      { blocked: false },
      'an element no rule describes must pass',
    )

    // Among several site rules, the one that matched is the one returned.
    assert.deepStrictEqual(
      await checkAcl('click', { page: 3, element: 11 }, checkoutBrowser, [
        deleteAccountRule,
        placeOrderRule,
      ]),
      { blocked: true, rule: placeOrderRule, pageId: 3, elementId: 11 },
      'the matched rule must be the one returned',
    )

    // A disabled rule is not enforced, however exactly it would match.
    const retiredRule: AclRule = {
      id: 'retired',
      sitePattern: 'shop.example.com',
      textMatch: 'place order',
      enabled: false,
    }
    assert.deepStrictEqual(
      await checkAcl('click', { page: 3, element: 11 }, checkoutBrowser, [
        retiredRule,
      ]),
      { blocked: false },
      'a disabled rule must not block',
    )
  })
})
