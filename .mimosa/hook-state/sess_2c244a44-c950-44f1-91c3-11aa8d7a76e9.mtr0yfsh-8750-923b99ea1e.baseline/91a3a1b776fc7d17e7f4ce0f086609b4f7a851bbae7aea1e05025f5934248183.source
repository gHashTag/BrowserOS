import { readdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { getBuiltinSkillsDir, getSkillsDir } from '../lib/browseros-dir'
import { logger } from '../lib/logger'
import { DEFAULT_SKILLS } from './defaults'

const DEFAULT_SKILL_IDS = new Set(DEFAULT_SKILLS.map((s) => s.id))

export async function migrateBuiltinSkills(): Promise<void> {
  const builtinDir = getBuiltinSkillsDir()

  try {
    const entries = await readdir(builtinDir)
    if (entries.some((e) => !e.startsWith('.'))) return
  } catch {
    return
  }

  const skillsDir = getSkillsDir()
  let migrated = 0

  for (const id of DEFAULT_SKILL_IDS) {
    const sourcePath = join(skillsDir, id)
    try {
      const s = await stat(join(sourcePath, 'SKILL.md'))
      if (!s.isFile()) continue
    } catch {
      continue
    }

    try {
      await rename(sourcePath, join(builtinDir, id))
      migrated++
    } catch (err) {
      logger.warn('Failed to migrate builtin skill', {
        id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  if (migrated > 0) {
    logger.info(`Migrated ${migrated} built-in skills to builtin/ directory`)
  }
}
