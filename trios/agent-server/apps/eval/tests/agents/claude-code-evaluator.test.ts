import { describe, expect, it } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgent } from '../../src/agents'
import { ClaudeCodeEvaluator } from '../../src/agents/claude-code'
import { CaptureContext } from '../../src/capture/context'
import {
  AgentConfigSchema,
  type EvalConfig,
  EvalConfigSchema,
  type Task,
  TaskMetadataSchema,
} from '../../src/types'

function config(): EvalConfig {
  return {
    agent: {
      type: 'claude-code',
      model: 'opus',
      claudePath: 'claude',
      extraArgs: [],
    },
    dataset: 'data/test.jsonl',
    num_workers: 1,
    restart_server_per_task: false,
    browseros: {
      server_url: 'http://127.0.0.1:9110',
      base_cdp_port: 9010,
      base_server_port: 9110,
      base_extension_port: 9310,
      load_extensions: false,
      headless: false,
    },
    graders: [],
  }
}

const task: Task = {
  query_id: 'task-1',
  dataset: 'test',
  query: 'Find the title',
  graders: [],
  metadata: {
    original_task_id: 'task-1',
  },
}

describe('ClaudeCodeEvaluator', () => {
  it('accepts claude-code config defaults without permission mode', () => {
    const agent = AgentConfigSchema.parse({ type: 'claude-code' })

    expect(agent).toEqual({
      type: 'claude-code',
      claudePath: 'claude',
      extraArgs: [],
    })
  })

  it('accepts claude-code as a runnable eval agent', () => {
    const parsed = EvalConfigSchema.parse({
      agent: {
        type: 'claude-code',
        model: 'opus',
      },
      dataset: 'data/test-set.jsonl',
      browseros: {
        server_url: 'http://127.0.0.1:9110',
      },
    })

    expect(parsed.agent.type).toBe('claude-code')
    expect(parsed.agent.model).toBe('opus')
  })

  it('rejects unsupported claude-code settings instead of silently ignoring them', () => {
    expect(
      AgentConfigSchema.safeParse({
        type: 'claude-code',
        permissionMode: 'bypassPermissions',
      }).success,
    ).toBe(false)
    expect(
      AgentConfigSchema.safeParse({
        type: 'claude-code',
        maxTurns: 3,
      }).success,
    ).toBe(false)
  })

  it('allows claude-code in task metadata', () => {
    const metadata = TaskMetadataSchema.parse({
      query_id: 'task-1',
      dataset: 'test',
      query: 'Do the thing',
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      total_duration_ms: 100,
      total_steps: 1,
      termination_reason: 'completed',
      final_answer: 'done',
      errors: [],
      warnings: [],
      agent_config: {
        type: 'claude-code',
        model: 'opus',
      },
      grader_results: {},
    })

    expect(metadata.agent_config.type).toBe('claude-code')
  })

  it('is created by the agent factory', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'claude-code-eval-'))
    const { capture, taskOutputDir } = await CaptureContext.create({
      serverUrl: 'http://127.0.0.1:9110',
      outputDir,
      taskId: task.query_id,
      initialPageId: 1,
    })

    const agent = createAgent({
      config: config(),
      task,
      workerIndex: 0,
      initialPageId: 1,
      outputDir,
      taskOutputDir,
      capture,
    })

    expect(agent).toBeInstanceOf(ClaudeCodeEvaluator)
  })

  it('runs claude code, logs messages, writes MCP config, and saves metadata', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'claude-code-eval-'))
    const { capture, taskOutputDir } = await CaptureContext.create({
      serverUrl: 'http://127.0.0.1:9110',
      outputDir,
      taskId: task.query_id,
      initialPageId: 1,
    })
    const calls: Array<{ executable: string; args: string[]; cwd: string }> = []
    const evaluator = new ClaudeCodeEvaluator(
      {
        config: config(),
        task,
        workerIndex: 0,
        initialPageId: 1,
        outputDir,
        taskOutputDir,
        capture,
      },
      {
        processRunner: {
          async run(options) {
            calls.push(options)
            await options.onStdoutLine(
              JSON.stringify({
                type: 'assistant',
                message: {
                  content: [{ type: 'text', text: 'The title is Example' }],
                },
              }),
            )
            await options.onStdoutLine(
              JSON.stringify({
                type: 'result',
                subtype: 'success',
                result: 'The title is Example',
              }),
            )
            return { exitCode: 0, stderr: '' }
          },
        },
      },
    )

    const result = await evaluator.execute()

    expect(result.finalAnswer).toBe('The title is Example')
    expect(result.metadata.agent_config).toMatchObject({
      type: 'claude-code',
      model: 'opus',
    })
    expect(result.messages.some((msg) => msg.type === 'user')).toBe(true)
    expect(result.messages.some((msg) => msg.type === 'text-delta')).toBe(true)
    const mcpConfig = JSON.parse(
      await readFile(join(taskOutputDir, 'claude-code-mcp.json'), 'utf-8'),
    )
    expect(mcpConfig.mcpServers.browseros).toMatchObject({
      type: 'http',
      url: 'http://127.0.0.1:9110/mcp',
      headers: {
        'X-BrowserOS-Source': 'sdk-internal',
      },
    })
    expect(calls).toEqual([
      expect.objectContaining({
        executable: 'claude',
        cwd: taskOutputDir,
        args: [
          '-p',
          expect.stringContaining('Task: Find the title'),
          '--mcp-config',
          join(taskOutputDir, 'claude-code-mcp.json'),
          '--strict-mcp-config',
          '--output-format',
          'stream-json',
          '--verbose',
          '--model',
          'opus',
        ],
      }),
    ])
    expect(calls[0].args).not.toContain('--permission-mode')
  })

  it('records non-fatal stream processing errors as warnings', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'claude-code-eval-'))
    const { capture, taskOutputDir } = await CaptureContext.create({
      serverUrl: 'http://127.0.0.1:9110',
      outputDir,
      taskId: task.query_id,
      initialPageId: 1,
    })
    const evaluator = new ClaudeCodeEvaluator(
      {
        config: config(),
        task,
        workerIndex: 0,
        initialPageId: 1,
        outputDir,
        taskOutputDir,
        capture,
      },
      {
        processRunner: {
          async run(options) {
            await options.onStdoutLine(
              JSON.stringify({
                type: 'result',
                subtype: 'success',
                result: 'done',
              }),
            )
            return {
              exitCode: 0,
              stderr: '',
              streamErrors: ['bad stream line'],
            }
          },
        },
      },
    )

    const result = await evaluator.execute()

    expect(result.finalAnswer).toBe('done')
    expect(result.metadata.warnings).toEqual([
      expect.objectContaining({
        source: 'message_logging',
        message: 'Claude Code stream event processing failed: bad stream line',
      }),
    ])
  })
})
