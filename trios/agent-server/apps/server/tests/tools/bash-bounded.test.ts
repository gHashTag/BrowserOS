import { describe, expect, it } from 'bun:test'
import {
  createBashTool,
  effectiveTimeout,
} from '../../src/tools/filesystem/bash'

async function run(command: string, timeout?: number) {
  const tool = createBashTool(process.cwd())
  // biome-ignore lint/suspicious/noExplicitAny: ai-sdk ToolExecutionOptions
  return (await (tool as any).execute(
    { command, timeout },
    {
      toolCallId: 'test',
      messages: [],
    },
  )) as { text?: string; content?: Array<{ text: string }>; isError?: boolean }
}
function textOf(r: Awaited<ReturnType<typeof run>>): string {
  return r.text ?? r.content?.[0]?.text ?? ''
}

describe('filesystem_bash output bounding', () => {
  // The defect: `new Response(stream).text()` held the whole output before
  // truncateTail ever saw it. Measured on the container, a 257 MB `cat` cost
  // 889.8 MB of RSS to return 51 KB - one careless command setting the memory
  // ceiling for every other agent sharing the process.
  it('returns a bounded tail of a huge output, and says what it discarded', async () => {
    const r = await run(
      'awk \'BEGIN{for(i=0;i<200000;i++) print "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}\'',
      120,
    )
    const text = textOf(r)
    expect(text.length).toBeLessThan(200_000)
    expect(text).toContain('characters were discarded while the command ran')
  }, 180_000)

  it('returns small output whole, with no discard note', async () => {
    const text = textOf(await run('printf "alpha\\nbeta\\n"'))
    expect(text).toContain('alpha')
    expect(text).toContain('beta')
    expect(text).not.toContain('discarded')
  }, 30_000)
})

describe('filesystem_bash timeout cap', () => {
  // `timeout` is model-supplied and was unbounded: a command asking for a day
  // and hanging held its slot for a day, and slots are what bound the swarm.
  it('caps an unbounded request and reports that it did', () => {
    expect(effectiveTimeout(99_999)).toEqual({ seconds: 900, capped: true })
  })
  it('leaves a reasonable request alone', () => {
    expect(effectiveTimeout(30)).toEqual({ seconds: 30, capped: false })
  })
  it('treats absent and nonsensical the same as the default', () => {
    expect(effectiveTimeout(undefined).seconds).toBe(120)
    expect(effectiveTimeout(0).seconds).toBe(120)
    expect(effectiveTimeout(-5).seconds).toBe(120)
  })
})
