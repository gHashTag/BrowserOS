import { describe, it } from 'bun:test'
import assert from 'node:assert'
import {
  TOOL_APPROVAL_CATEGORY_IDS,
  type ToolApprovalConfig,
} from '@browseros/shared/constants/tool-approval'
import { getApprovedBrowserToolNames } from '../../src/agent/tool-adapter'
import { registry } from '../../src/tools/registry'

describe('tool approval enforcement', () => {
  it('assigns every registered browser tool to a known approval category', () => {
    const knownCategories = new Set(TOOL_APPROVAL_CATEGORY_IDS)

    for (const tool of registry.all()) {
      assert.ok(
        knownCategories.has(tool.approvalCategory),
        `Unknown approval category for ${tool.name}: ${tool.approvalCategory}`,
      )
    }
  })

  it('covers the full registry when all approval categories are enabled', () => {
    const config: ToolApprovalConfig = {
      categories: Object.fromEntries(
        TOOL_APPROVAL_CATEGORY_IDS.map((id) => [id, true]),
      ),
    }

    const approvedToolNames = getApprovedBrowserToolNames(registry, config)

    assert.deepStrictEqual(approvedToolNames.sort(), registry.names().sort())
  })

  it('exposes window visibility as data-modification', () => {
    const tool = registry.get('set_window_visibility')

    assert.ok(tool, 'Expected set_window_visibility to be registered')
    assert.strictEqual(tool.approvalCategory, 'data-modification')
  })
})
