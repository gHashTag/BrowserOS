/**
 * @license AGPL-3.0-or-later
 * Copyright 2026 TRIOS
 *
 * Contract suite for src/bridge-server.ts.
 *
 * The module's sole runtime export, createBridgeServer, is pinned here by
 * driving the McpServer **returns over a genuine MCP protocol session**
 * (InMemoryTransport linked to a Client from the SDK) and asserting only
 * what a protocol peer can observe: the advertised tool list, the
 * advertised input schemas, and the results of tool calls.
 *
 * Export coverage of src/bridge-server.ts:
 *  - createBridgeServer — exercised throughout this suite.
 *  - BridgeDeps is a type-only export with no runtime behaviour of its
 *    own; it is used below only as the cast target for the stand-ins.
 *
 * No export is left unexercised because of a live dependency: every
 * client carried by BridgeDeps (BrowserOS, GitButler, tri, RAG, Railway,
 * GitHub) is replaced by an in-process stand-in whose responses are
 * echoed into tool output, so the suite needs no network, no database
 * and no container.
 */

import { describe, expect, it } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { type BridgeDeps, createBridgeServer } from './bridge-server.js'

/** Tools that must be advertised when no optional client is configured. */
const BASE_TOOLS = [
  'gitbutler_analyze_ui',
  'gitbutler_workspace_status',
  'gitbutler_commit_visible',
  'gitbutler_create_branch',
  'gitbutler_push_stack',
  'gitbutler_stage',
  'gitbutler_absorb',
  'gitbutler_absorb_smart',
  'gitbutler_undo_last_commit',
  'gitbutler_pull',
  'gitbutler_screenshot',
  'gitbutler_bridge_health',
  'tri_run',
  'tri_spec_edit',
  'tri_experience_read',
  'discard_file_changes',
  'list_tab_groups',
  'create_tab_group',
  'search_chapters',
  'get_chapter',
  'list_chapters',
  'forbidden_audit',
  'get_claim_status',
  'build_cover',
  'build_pdf',
  'list_claims',
  'get_honest_counters',
  'preview_chapter_update',
  'backup_ssot',
  'railway_redeploy',
  'railway_deploy',
  'railway_list_services',
  'railway_fleet_health',
]

/** Additional tools that appear only when the GitHub client is present. */
const GITHUB_TOOLS = [
  'github_repo_info',
  'github_read_file',
  'github_list_files',
  'github_list_issues',
  'github_create_issue',
  'github_create_pr',
  'github_list_commits',
  'github_search_code',
  'github_list_branches',
  'github_get_workflow_status',
  'github_add_comment',
  'github_list_pulls',
]

type AnyRecord = Record<string, unknown>

/** Build a full set of stand-in deps; failures are toggled via the mode. */
function makeDeps(mode: {
  railway: AnyRecord | null
  github: AnyRecord | null
  noGitButlerPage?: boolean
  branchesFail?: boolean
  statusFails?: boolean
  commitFails?: boolean
  undoFails?: boolean
  stageFails?: boolean
  discardFails?: boolean
  triFails?: boolean
  ragFails?: boolean
  ghFails?: boolean
  tabGroupFails?: boolean
  noExperiences?: boolean
}): BridgeDeps {
  const extractText = (result: unknown): string => {
    const content = (result as AnyRecord | null | undefined)?.content
    if (Array.isArray(content)) {
      const first = content[0] as AnyRecord | undefined
      if (first && typeof first.text === 'string') return first.text
    }
    return ''
  }

  const deps = {
    config: {
      port: 9311,
      browserosMcpUrl: 'http://127.0.0.1:9200/mcp',
      gitbutlerCliPath: 'but',
      gitbutlerInternal: true,
      triCliPath: 'tri',
      workingDir: '/virtual/igla',
      logLevel: 'error',
      triosRagCliPath: 'trios-mcp-rag',
      databaseUrl: null,
      railwayMcpUrl: null,
      githubCliPath: 'trios-mcp-github',
    },
    browseros: {
      findGitButlerPage: async () =>
        mode.noGitButlerPage
          ? null
          : {
              id: 12,
              url: 'https://app.gitbutler.com/workspace',
              title: 'GitButler',
            },
      // Screenshot payload is Base64; it encodes the page it came from.
      takeScreenshot: async (pageId: number) => ({
        data: Buffer.from(`img:${pageId}`).toString('base64'),
        mimeType: 'image/png',
        devicePixelRatio: 2,
      }),
      takeSnapshot: async (pageId: number) => ({
        snapshot: `accessibility tree of page ${pageId}: GitButler workspace window`,
      }),
      listTools: async () => ['tabs', 'screenshot', 'navigate'],
      listTabGroups: async () => [
        { id: 'grp-77', title: 'IGLA', color: 'blue', tabs: [12] },
      ],
      createTabGroup: async (
        pageIds: number[],
        title?: string,
        color?: string,
      ) =>
        mode.tabGroupFails
          ? { ok: false, groupId: undefined }
          : { ok: true, groupId: `grp:${pageIds.join('+')}:${title}:${color}` },
    },
    gitbutler: {
      isConnected: true,
      listTools: async () => ['gb_list', 'gb_status'],
      getStatus: async () => {
        if (mode.statusFails) throw new Error('igla down')
        return {
          branch: 'igla/main',
          ahead: 2,
          behind: 1,
          staged: [{ path: 'src/bridge.ts', status: 'modified' }],
          unstaged: [{ path: 'docs/note.md', status: 'modified' }],
          untracked: ['scratch.txt'],
          conflicted: [],
        }
      },
      getBranches: async () => {
        if (mode.branchesFail) throw new Error('branch rpc down')
        return [
          {
            name: 'igla/alpha',
            isCurrent: true,
            isRemote: false,
            ahead: 2,
            behind: 1,
          },
          {
            name: 'igla/beta',
            isCurrent: false,
            isRemote: true,
            ahead: 0,
            behind: 3,
          },
        ]
      },
      createBranch: async (name: string, base?: string) =>
        `branch-created:${name}@${base ?? 'HEAD'}`,
      commit: async (_message: string) =>
        mode.commitFails
          ? { success: false, error: 'workspace locked' }
          : { success: true, hash: '9f8e7d6' },
      stage: async (files: string[]) => {
        if (mode.stageFails) throw new Error('butler busy')
        return `staged-ok:${files.join('|')}`
      },
      push: async (branch?: string) => `push-ok:${branch ?? 'current'}`,
      pull: async () => 'pull-ok',
      absorb: async () => 'absorb-ok',
      discard: async (files: string[]) => {
        if (mode.discardFails) throw new Error('cannot discard')
        return `discard-ok:${files.join('|')}`
      },
      undoLastCommit: async () => {
        if (mode.undoFails) throw new Error('nothing to undo')
        return { hash: 'abc0099', message: 'wip: bridge' }
      },
    },
    tri: {
      run: async (args: string[]) => {
        if (mode.triFails) throw new Error('tri binary missing')
        return {
          ok: true,
          exitCode: 0,
          command: args.join(' '),
          stdout: `argv:${JSON.stringify(args)}`,
          stderr: '',
        }
      },
      specEdit: async (
        specPath: string,
        _content: string,
        runTest: boolean,
      ) => ({
        ok: true,
        reason: 'spec written',
        specPath,
        testPassed: runTest,
        testOutput: 't27 ok',
      }),
      readExperiences: async (_count: number) =>
        mode.noExperiences
          ? []
          : [
              {
                fileName: '2026-09-04.md',
                modified: '2026-09-04T10:00:00Z',
                content: 'lesson learned',
              },
            ],
    },
    rag: {
      callTool: async (name: string, args: AnyRecord) => {
        if (mode.ragFails) throw new Error('RAG unreachable')
        return {
          content: [
            { type: 'text', text: `rag>${name} ${JSON.stringify(args)}` },
          ],
        }
      },
      extractText,
    },
    railway: mode.railway
      ? {
          isConnected: true,
          listTools: async () => ['railway_list'],
          redeploy: async (
            serviceId?: string,
            project?: string,
            environment?: string,
          ) => `redeploy:${serviceId}:${project}:${environment}`,
          deploy: async (opts: AnyRecord) =>
            `deploy:${opts.serviceName}@${opts.image}`,
          listServices: async (_project?: string) => [
            { serviceId: 'svc-1', name: 'igla-web', status: 'running' },
          ],
          fleetHealth: async () => 'Fleet: 4/5 healthy',
        }
      : null,
    github: mode.github
      ? {
          isConnected: true,
          listTools: async () => ['gh_repo'],
          callTool: async (name: string, args: AnyRecord) => {
            if (mode.ghFails) throw new Error('github token expired')
            return {
              content: [
                { type: 'text', text: `gh>${name} ${JSON.stringify(args)}` },
              ],
            }
          },
          extractText,
        }
      : null,
  }

  return deps as unknown as BridgeDeps
}

/** Link a fresh bridge server to a protocol client and return the pair. */
async function startSession(deps: BridgeDeps) {
  const server = createBridgeServer(deps)
  const client = new Client({ name: 'contract-suite', version: '1.0.0' })
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ])
  return {
    client,
    call: (name: string, args: AnyRecord = {}) =>
      client.callTool({ name, arguments: args }),
    finish: async () => {
      await client.close()
    },
  }
}

/** First text block of a tool result. */
function textOf(result: AnyRecord): string {
  const part = result.content?.find((block: AnyRecord) => block.type === 'text')
  return String(part?.text ?? '')
}

/** First text block of a tool result, parsed as JSON. */
function jsonOf(result: AnyRecord): AnyRecord {
  return JSON.parse(textOf(result)) as AnyRecord
}

describe('bridgeServerContract', () => {
  it('createBridgeServer exposes and serves the TRIOS bridge tool contract over MCP', async () => {
    // ------------------------------------------------------------------
    // 1. Tool surface with no optional clients (railway and github null)
    // ------------------------------------------------------------------
    const lean = await startSession(makeDeps({ railway: null, github: null }))
    const listed = await lean.client.listTools()
    const names = listed.tools.map((t) => t.name).sort()
    expect(names).toEqual([...BASE_TOOLS].sort())

    // Advertised input schemas are part of the contract.
    const byName = new Map(listed.tools.map((t) => [t.name, t]))
    const analyze = byName.get('gitbutler_analyze_ui')
    expect(analyze?.description).toContain('screenshot of the GitButler UI')
    const analyzeSchema = analyze?.inputSchema as AnyRecord
    expect(analyzeSchema.properties?.page_id?.type).toBe('number')
    expect(analyzeSchema.required).toBeUndefined()
    const commit = byName.get('gitbutler_commit_visible')
    const commitSchema = commit?.inputSchema as AnyRecord
    expect(commitSchema.properties?.message?.type).toBe('string')
    expect(commitSchema.properties?.message?.minLength).toBe(1)
    expect(commitSchema.properties?.message?.maxLength).toBe(2048)
    expect(commitSchema.required).toEqual(['message'])

    // ------------------------------------------------------------------
    // 2. GitButler workflow tools: results derived from the stand-ins
    // ------------------------------------------------------------------
    const status = (await lean.call('gitbutler_workspace_status')) as AnyRecord
    expect(status.isError).toBeUndefined()
    const statusText = textOf(status)
    expect(statusText).toContain('## Workspace Status')
    expect(statusText).toContain('- **Branch:** igla/main')
    expect(statusText).toContain('- **Ahead:** 2 | **Behind:** 1')
    expect(statusText).toContain(
      '- **Staged:** 1 | **Unstaged:** 1 | **Untracked:** 1 | **Conflicts:** 0',
    )
    expect(statusText).toContain(
      '### Staged Changes\n- `modified` src/bridge.ts',
    )
    expect(statusText).toContain(
      '### Unstaged Changes\n- `modified` docs/note.md',
    )
    expect(statusText).toContain('### Untracked Files\n- scratch.txt')
    expect(statusText).toContain('### Branches')
    expect(statusText).toContain('- igla/alpha (↑2 ↓1) **← current**')
    expect(statusText).toContain('- igla/beta (↑0 ↓3)')

    const committed = await lean.call('gitbutler_commit_visible', {
      message: 'ship the bridge',
      files: ['src/one.ts', 'src/two.ts'],
    })
    expect((committed as AnyRecord).isError).toBeUndefined()
    expect(textOf(committed as AnyRecord)).toEqual(
      '✅ Committed successfully!\n' +
        '- **Hash:** 9f8e7d6\n' +
        '- **Message:** ship the bridge\n' +
        '- **Files:** src/one.ts, src/two.ts',
    )

    expect(
      textOf(
        (await lean.call('gitbutler_create_branch', {
          name: 'igla/gamma',
          base: 'igla/alpha',
        })) as AnyRecord,
      ),
    ).toEqual(
      '✅ Branch created: **igla/gamma** (based on igla/alpha)\n' +
        'branch-created:igla/gamma@igla/alpha',
    )

    expect(
      textOf(
        (await lean.call('gitbutler_push_stack', {
          branch: 'igla/alpha',
        })) as AnyRecord,
      ),
    ).toEqual('✅ Pushed successfully!\npush-ok:igla/alpha')

    expect(
      textOf(
        (await lean.call('gitbutler_stage', {
          files: ['src/one.ts'],
        })) as AnyRecord,
      ),
    ).toEqual('✅ Staged 1 file(s):\n- src/one.ts\nstaged-ok:src/one.ts')

    expect(textOf((await lean.call('gitbutler_absorb')) as AnyRecord)).toEqual(
      '✅ Changes absorbed into appropriate commits!\nabsorb-ok',
    )

    expect(textOf((await lean.call('gitbutler_pull')) as AnyRecord)).toEqual(
      '✅ Pulled latest changes!\npull-ok',
    )

    expect(jsonOf(await lean.call('gitbutler_undo_last_commit'))).toEqual({
      ok: true,
      reason:
        'Undone commit "wip: bridge" (HEAD is now abc0099). Files are back in staged state.',
      undoneHash: 'abc0099',
      undoneMessage: 'wip: bridge',
    })

    expect(
      jsonOf(
        await lean.call('discard_file_changes', {
          files: ['a.ts', 'b.ts'],
        }),
      ),
    ).toEqual({
      ok: true,
      reason: 'Discarded changes in 2 file(s).',
      files: ['a.ts', 'b.ts'],
    })

    // ------------------------------------------------------------------
    // 3. Vision tools: screenshot and analysis of the GitButler tab
    // ------------------------------------------------------------------
    const analyzed = (await lean.call('gitbutler_analyze_ui', {
      page_id: 12,
    })) as AnyRecord
    const analyzedParts = analyzed.content as AnyRecord[]
    expect(analyzedParts.map((p) => p.type)).toEqual(['text', 'image'])
    expect(analyzedParts[1]).toMatchObject({
      type: 'image',
      data: Buffer.from('img:12').toString('base64'),
      mimeType: 'image/png',
    })
    const analysisText = String(analyzedParts[0].text)
    expect(analysisText).toContain('## GitButler UI Analysis')
    expect(analysisText).toContain('**Branch:** igla/main')
    expect(analysisText).toContain('**Clean:** No ❌')
    expect(analysisText).toContain(
      '**Summary:** Branch: igla/main (↑2 ↓1). 1 staged, 2 unstaged, 1 untracked, 0 conflicted files.',
    )
    expect(analysisText).toContain(
      '### Changed Files (3)\n- [modified] src/bridge.ts — ✅ staged',
    )
    expect(analysisText).toContain('- [untracked] scratch.txt — ⬜ unstaged')
    const fenced = /```json\n([\s\S]*?)```/.exec(analysisText)
    expect(fenced).not.toBeNull()
    const fencedJson = fenced?.[1]
    expect(fencedJson).toBeDefined()
    const structured = JSON.parse(fencedJson) as AnyRecord
    expect(structured.activeBranch).toBe('igla/main')
    expect(structured.isClean).toBe(false)
    expect(structured.changedFiles[0]).toEqual({
      path: 'src/bridge.ts',
      status: 'modified',
      staged: true,
    })

    const shot = (await lean.call('gitbutler_screenshot')) as AnyRecord
    const shotParts = shot.content as AnyRecord[]
    expect(String(shotParts[0].text)).toBe(
      'Screenshot of GitButler (page 12, https://app.gitbutler.com/workspace)',
    )
    expect(shotParts[1]).toMatchObject({
      type: 'image',
      data: Buffer.from('img:12').toString('base64'),
    })

    // ------------------------------------------------------------------
    // 4. Browser tab-group tools and the tri CLI tools
    // ------------------------------------------------------------------
    expect(jsonOf(await lean.call('list_tab_groups'))).toEqual({
      ok: true,
      groups: [{ id: 'grp-77', title: 'IGLA', color: 'blue', tabs: [12] }],
      count: 1,
    })

    expect(
      jsonOf(
        await lean.call('create_tab_group', {
          page_ids: [3, 5, 9],
          title: 'IGLA',
          color: 'purple',
        }),
      ),
    ).toEqual({
      ok: true,
      reason: 'Created tab group with 3 tabs.',
      groupId: 'grp:3+5+9:IGLA:purple',
    })

    // The command string is split on whitespace before execution.
    expect(
      jsonOf(await lean.call('tri_run', { command: '  test   spec.t27  ' })),
    ).toEqual({
      ok: true,
      exitCode: 0,
      command: 'test spec.t27',
      stdout: 'argv:["test","spec.t27"]',
      stderr: '',
    })

    expect(
      jsonOf(
        await lean.call('tri_spec_edit', {
          specPath: 'phi/spec.t27',
          content: 'GIVEN the bridge',
          runTest: false,
        }),
      ),
    ).toEqual({
      ok: true,
      reason: 'spec written',
      specPath: 'phi/spec.t27',
      testPassed: false,
      testOutput: 't27 ok',
    })

    expect(
      jsonOf(await lean.call('tri_experience_read', { count: 2 })),
    ).toEqual({
      ok: true,
      reason: 'Found 1 experience entry/entries.',
      entries: [
        {
          fileName: '2026-09-04.md',
          modified: '2026-09-04T10:00:00Z',
          content: 'lesson learned',
        },
      ],
    })

    // ------------------------------------------------------------------
    // 5. RAG pass-through tools: names and argument mapping
    // ------------------------------------------------------------------
    expect(
      textOf(
        (await lean.call('search_chapters', {
          query: 'phi',
          limit: 2,
        })) as AnyRecord,
      ),
    ).toBe('rag>search_chapters {"query":"phi","limit":2}')
    expect(
      textOf(
        (await lean.call('get_chapter', { slug: 'cp-violation' })) as AnyRecord,
      ),
    ).toBe('rag>get_chapter {"slug":"cp-violation"}')
    expect(textOf((await lean.call('list_chapters')) as AnyRecord)).toBe(
      'rag>list_chapters {}',
    )
    expect(textOf((await lean.call('forbidden_audit')) as AnyRecord)).toBe(
      'rag>forbidden_audit {}',
    )
    // An omitted optional query is forwarded as an empty string.
    expect(textOf((await lean.call('get_claim_status')) as AnyRecord)).toBe(
      'rag>get_claim_status {"query":""}',
    )
    expect(
      textOf(
        (await lean.call('get_claim_status', { query: 'higgs' })) as AnyRecord,
      ),
    ).toBe('rag>get_claim_status {"query":"higgs"}')
    expect(textOf((await lean.call('build_cover')) as AnyRecord)).toBe(
      'rag>build_cover {}',
    )
    // camelCase tool arguments are mapped to the snake_case RAG arguments.
    expect(
      textOf(
        (await lean.call('build_pdf', {
          dryRun: false,
          bookMode: true,
          limit: 3,
          pdfName: 'igla.pdf',
          outDir: '/tmp/out',
        })) as AnyRecord,
      ),
    ).toBe(
      'rag>build_pdf {"dry_run":false,"book_mode":true,"limit":3,"pdf_name":"igla.pdf","out_dir":"/tmp/out"}',
    )
    expect(textOf((await lean.call('list_claims')) as AnyRecord)).toBe(
      'rag>list_claims {}',
    )
    expect(textOf((await lean.call('get_honest_counters')) as AnyRecord)).toBe(
      'rag>get_honest_counters {}',
    )
    expect(
      textOf(
        (await lean.call('preview_chapter_update', {
          slug: 'phi-squared-identity',
          newTitle: 'New',
          newBody: 'Body',
        })) as AnyRecord,
      ),
    ).toBe(
      'rag>preview_chapter_update {"slug":"phi-squared-identity","new_title":"New","new_body_md":"Body"}',
    )
    expect(
      textOf((await lean.call('backup_ssot', { confirm: true })) as AnyRecord),
    ).toBe('rag>backup_ssot {"confirm":true}')

    // ------------------------------------------------------------------
    // 6. Smart absorb produces a dry-run plan over the protocol
    // ------------------------------------------------------------------
    const plan = jsonOf(
      await lean.call('gitbutler_absorb_smart', {
        strategy: 'by-directory',
        dryRun: true,
      }),
    )
    expect(plan.ok).toBe(true)
    expect(plan.reason).toContain('Dry run')
    expect(plan.plan.strategy).toBe('by-directory')
    const planBranches = plan.plan.branches as AnyRecord[]
    expect(planBranches.map((b) => b.branchName)).toEqual([
      'igla/main/src',
      'igla/main/docs',
      'igla/main/root-files',
    ])
    expect((planBranches[0].files as AnyRecord[])[0].path).toBe('src/bridge.ts')

    // ------------------------------------------------------------------
    // 7. Health check reports each connection plus the bridge config
    // ------------------------------------------------------------------
    const health = textOf(
      (await lean.call('gitbutler_bridge_health')) as AnyRecord,
    )
    expect(health).toContain('## TRIOS MCP Bridge Health Check')
    expect(health).toContain(
      '✅ **BrowserOS MCP**: Connected (3 tools available)',
    )
    expect(health).toContain(
      '✅ **GitButler CLI**: Available (branch: igla/main)',
    )
    expect(health).toContain('✅ **GitButler MCP**: Connected (2 tools)')
    expect(health).toContain('**Working Dir:** /virtual/igla')
    expect(health).toContain('**Bridge Port:** 9311')

    // ------------------------------------------------------------------
    // 8. Railway tools are gated on the optional Railway client
    // ------------------------------------------------------------------
    const railwayGated: Array<[string, AnyRecord]> = [
      ['railway_redeploy', {}],
      ['railway_deploy', { serviceName: 'igla-web' }],
      ['railway_list_services', {}],
      ['railway_fleet_health', {}],
    ]
    for (const [name, args] of railwayGated) {
      const gated = (await lean.call(name, args)) as AnyRecord
      expect(gated.isError).toBe(true)
      expect(jsonOf(gated).ok).toBe(false)
      expect(String(jsonOf(gated).reason)).toContain(
        'Railway MCP not configured',
      )
    }
    await lean.finish()

    // ------------------------------------------------------------------
    // 9. With Railway and GitHub clients present the surface grows
    // ------------------------------------------------------------------
    const full = await startSession(
      makeDeps({
        railway: { placeholder: true },
        github: { placeholder: true },
      }),
    )
    const fullNames = (await full.client.listTools()).tools
      .map((t) => t.name)
      .sort()
    expect(fullNames).toEqual([...BASE_TOOLS, ...GITHUB_TOOLS].sort())

    expect(
      jsonOf(
        await full.call('railway_redeploy', {
          serviceId: 'svc-1',
          project: 'proj-9',
          environment: 'env-3',
        }),
      ),
    ).toEqual({ ok: true, redeployResult: 'redeploy:svc-1:proj-9:env-3' })

    expect(
      jsonOf(
        await full.call('railway_deploy', {
          serviceName: 'igla-web',
          image: 'ghcr.io/trios/igla:1',
        }),
      ),
    ).toEqual({
      ok: true,
      deployResult: 'deploy:igla-web@ghcr.io/trios/igla:1',
    })

    expect(jsonOf(await full.call('railway_list_services'))).toEqual({
      ok: true,
      services: [{ serviceId: 'svc-1', name: 'igla-web', status: 'running' }],
    })

    expect(textOf((await full.call('railway_fleet_health')) as AnyRecord)).toBe(
      '## Railway Fleet Health\n\nFleet: 4/5 healthy',
    )

    expect(
      textOf(
        (await full.call('github_repo_info', {
          owner: 'gHashTag',
          repo: 'trios',
        })) as AnyRecord,
      ),
    ).toBe('gh>github_repo_info {"owner":"gHashTag","repo":"trios"}')
    await full.finish()

    // ------------------------------------------------------------------
    // 10. Failure paths surface as isError results, never as crashes
    // ------------------------------------------------------------------
    const broken = await startSession(
      makeDeps({
        railway: null,
        github: { placeholder: true },
        noGitButlerPage: true,
        branchesFail: true,
        statusFails: true,
        commitFails: true,
        undoFails: true,
        stageFails: true,
        discardFails: true,
        triFails: true,
        ragFails: true,
        ghFails: true,
        tabGroupFails: true,
        noExperiences: true,
      }),
    )

    // No GitButler tab: both vision tools degrade to structured errors.
    const noTab = (await broken.call('gitbutler_analyze_ui')) as AnyRecord
    expect(noTab.isError).toBe(true)
    expect(jsonOf(noTab)).toEqual({
      error: 'GitButler tab not found',
      activeBranch: null,
      changedFiles: [],
      stacks: [],
      isClean: true,
      summary:
        'GitButler tab not found. Please open GitButler in the browser first.',
      suggestedActions: ['Open GitButler in the browser'],
    })
    const noTabShot = (await broken.call('gitbutler_screenshot')) as AnyRecord
    expect(noTabShot.isError).toBe(true)
    expect(textOf(noTabShot)).toBe(
      '❌ GitButler tab not found. Please open GitButler in the browser.',
    )

    // CLI failures are reported in the tool result.
    const statusErr = (await broken.call(
      'gitbutler_workspace_status',
    )) as AnyRecord
    expect(statusErr.isError).toBe(true)
    expect(textOf(statusErr)).toBe('Error getting workspace status: igla down')

    const commitErr = (await broken.call('gitbutler_commit_visible', {
      message: 'try again',
    })) as AnyRecord
    expect(commitErr.isError).toBe(true)
    expect(textOf(commitErr)).toBe('❌ Commit failed: workspace locked')

    const undoErr = (await broken.call(
      'gitbutler_undo_last_commit',
    )) as AnyRecord
    expect(undoErr.isError).toBe(true)
    expect(jsonOf(undoErr)).toEqual({ ok: false, reason: 'nothing to undo' })

    const stageErr = (await broken.call('gitbutler_stage', {
      files: ['a.ts'],
    })) as AnyRecord
    expect(stageErr.isError).toBe(true)
    expect(textOf(stageErr)).toBe('Error staging files: butler busy')

    const discardErr = (await broken.call('discard_file_changes', {
      files: ['a.ts'],
    })) as AnyRecord
    expect(discardErr.isError).toBe(true)
    expect(jsonOf(discardErr)).toEqual({ ok: false, reason: 'cannot discard' })

    const triErr = (await broken.call('tri_run', {
      command: 'verdict',
    })) as AnyRecord
    expect(triErr.isError).toBe(true)
    expect(jsonOf(triErr)).toEqual({ ok: false, reason: 'tri binary missing' })

    const ragErr = (await broken.call('search_chapters', {
      query: 'phi',
    })) as AnyRecord
    expect(ragErr.isError).toBe(true)
    expect(jsonOf(ragErr)).toEqual({ ok: false, reason: 'RAG unreachable' })

    const ghErr = (await broken.call('github_repo_info', {
      owner: 'o',
      repo: 'r',
    })) as AnyRecord
    expect(ghErr.isError).toBe(true)
    expect(jsonOf(ghErr)).toEqual({ ok: false, reason: 'github token expired' })

    // A failing tab-group creation reports ok:false without isError.
    const groupErr = jsonOf(
      await broken.call('create_tab_group', { page_ids: [1, 2], title: 'T' }),
    )
    expect(groupErr.ok).toBe(false)
    expect(groupErr.reason).toBe('Failed to create tab group.')
    expect('groupId' in groupErr).toBe(false)

    // No experience files is a successful, empty answer.
    expect(
      jsonOf(await broken.call('tri_experience_read', { count: 3 })),
    ).toEqual({
      ok: true,
      reason: 'No .trinity experience files found.',
      entries: [],
    })
    await broken.finish()

    // ------------------------------------------------------------------
    // 11. Advertised schemas are enforced on the way in
    // ------------------------------------------------------------------
    const strict = await startSession(makeDeps({ railway: null, github: null }))

    const emptyStage = (await strict.call('gitbutler_stage', {
      files: [],
    })) as AnyRecord
    expect(emptyStage.isError).toBe(true)
    expect(textOf(emptyStage)).toContain('Input validation error')
    expect(textOf(emptyStage)).toContain('gitbutler_stage')

    const emptyMessage = (await strict.call('gitbutler_commit_visible', {
      message: '',
    })) as AnyRecord
    expect(emptyMessage.isError).toBe(true)
    expect(textOf(emptyMessage)).toContain('Input validation error')

    const badEnum = (await strict.call('gitbutler_absorb_smart', {
      strategy: 'nonsense',
    })) as AnyRecord
    expect(badEnum.isError).toBe(true)
    expect(textOf(badEnum)).toContain('Input validation error')

    await strict.finish()
  })
})
