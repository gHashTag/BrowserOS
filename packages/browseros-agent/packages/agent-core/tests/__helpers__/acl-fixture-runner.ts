import { resolve } from 'node:path'

async function main(): Promise<void> {
  const fixtureName = process.argv[2]
  if (!fixtureName) {
    throw new Error('Fixture name is required')
  }

  process.env.LOG_LEVEL = 'silent'
  delete process.env.ACL_EMBEDDING_DISABLE

  const [{ scoreFixture }, { disposeSemanticPipeline }] = await Promise.all([
    import('../../src/tools/acl/acl-scorer'),
    import('../../src/tools/acl/acl-embeddings'),
  ])

  const fixturePath = resolve(
    import.meta.dir,
    `../__fixtures__/acl/${fixtureName}.json`,
  )
  const fixture = await Bun.file(fixturePath).json()
  const decision = await scoreFixture(
    fixture.tool_name,
    fixture.page_url,
    fixture.element,
    fixture.rules,
  )
  await disposeSemanticPipeline()
  process.stdout.write(JSON.stringify(decision))
}

main().catch((error) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  )
  process.exitCode = 1
})
