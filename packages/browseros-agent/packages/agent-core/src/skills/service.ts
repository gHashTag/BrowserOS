import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import matter from 'gray-matter'
import { getBuiltinSkillsDir, getSkillsDir } from '../lib/browseros-dir'
import { logger } from '../lib/logger'
import { isValidFrontmatter, loadAllSkills } from './loader'
import type {
  CreateSkillInput,
  SkillDetail,
  SkillFrontmatter,
  SkillMeta,
  UpdateSkillInput,
} from './types'

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

export function safeSkillDir(id: string): string {
  const skillsDir = getSkillsDir()
  const resolved = resolve(skillsDir, id)
  if (!resolved.startsWith(`${skillsDir}${sep}`)) {
    throw new Error('Invalid skill id')
  }
  return resolved
}

export function safeBuiltinSkillDir(id: string): string {
  const builtinDir = getBuiltinSkillsDir()
  const resolved = resolve(builtinDir, id)
  if (!resolved.startsWith(`${builtinDir}${sep}`)) {
    throw new Error('Invalid skill id')
  }
  return resolved
}

function buildSkillMd(frontmatter: SkillFrontmatter, content: string): string {
  return matter.stringify(content, frontmatter)
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

async function resolveSkillDir(
  id: string,
): Promise<{ dir: string; builtIn: boolean } | null> {
  const userDir = safeSkillDir(id)
  if (await fileExists(join(userDir, 'SKILL.md'))) {
    return { dir: userDir, builtIn: false }
  }
  const builtinDir = safeBuiltinSkillDir(id)
  if (await fileExists(join(builtinDir, 'SKILL.md'))) {
    return { dir: builtinDir, builtIn: true }
  }
  return null
}

export async function listSkills(): Promise<SkillMeta[]> {
  return loadAllSkills()
}

export async function getSkill(id: string): Promise<SkillDetail | null> {
  const resolved = await resolveSkillDir(id)
  if (!resolved) return null

  const skillMdPath = join(resolved.dir, 'SKILL.md')
  try {
    const raw = await readFile(skillMdPath, 'utf-8')
    const parsed = matter(raw)

    if (!isValidFrontmatter(parsed.data)) {
      logger.warn('Skill has invalid frontmatter', { id })
      return null
    }

    const meta = parsed.data.metadata
    return {
      id,
      name: meta?.['display-name'] || parsed.data.name,
      description: parsed.data.description,
      location: skillMdPath,
      enabled: meta?.enabled !== 'false',
      version: meta?.version,
      builtIn: resolved.builtIn,
      content: parsed.content.trim(),
    }
  } catch (err) {
    logger.warn('Failed to read skill', {
      id,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

export async function createSkill(input: CreateSkillInput): Promise<SkillMeta> {
  const id = slugify(input.name)
  if (!id) throw new Error('Invalid skill name')

  if (await fileExists(join(safeSkillDir(id), 'SKILL.md'))) {
    throw new Error(`Skill "${id}" already exists`)
  }
  if (await fileExists(join(safeBuiltinSkillDir(id), 'SKILL.md'))) {
    throw new Error(`Skill "${id}" already exists`)
  }

  const dirPath = safeSkillDir(id)
  await mkdir(dirPath, { recursive: true })
  const frontmatter: SkillFrontmatter = {
    name: id,
    description: input.description,
    metadata: {
      'display-name': input.name,
      enabled: 'true',
    },
  }
  await writeFile(
    join(dirPath, 'SKILL.md'),
    buildSkillMd(frontmatter, input.content),
  )

  return {
    id,
    name: input.name,
    description: input.description,
    location: join(dirPath, 'SKILL.md'),
    enabled: true,
    builtIn: false,
  }
}

export async function updateSkill(
  id: string,
  input: UpdateSkillInput,
): Promise<SkillMeta> {
  const resolved = await resolveSkillDir(id)
  if (!resolved) throw new Error(`Skill "${id}" not found`)

  const skillMdPath = join(resolved.dir, 'SKILL.md')
  const raw = await readFile(skillMdPath, 'utf-8')
  const parsed = matter(raw)
  if (!isValidFrontmatter(parsed.data)) {
    throw new Error(`Skill "${id}" has invalid frontmatter`)
  }

  const existing = parsed.data
  const existingMeta = existing.metadata ?? {}
  const displayName =
    input.name ?? existingMeta['display-name'] ?? existing.name
  const description = input.description ?? existing.description
  const content = input.content ?? parsed.content.trim()
  const enabled = input.enabled ?? existingMeta.enabled !== 'false'

  const frontmatter: SkillFrontmatter = {
    ...existing,
    name: id,
    description,
    metadata: {
      ...existingMeta,
      'display-name': displayName,
      enabled: String(enabled),
    },
  }

  await writeFile(skillMdPath, buildSkillMd(frontmatter, content))

  return {
    id,
    name: displayName,
    description,
    location: skillMdPath,
    enabled,
    version: existingMeta.version,
    builtIn: resolved.builtIn,
  }
}

export async function deleteSkill(id: string): Promise<void> {
  const resolved = await resolveSkillDir(id)
  if (!resolved) throw new Error(`Skill "${id}" not found`)
  if (resolved.builtIn) throw new Error('Cannot delete built-in skill')
  await rm(resolved.dir, { recursive: true })
}
