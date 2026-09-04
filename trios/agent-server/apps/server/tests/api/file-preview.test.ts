/**
 * @license
 * Copyright 2025 BrowserOS
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  IMAGE_PREVIEW_MAX_BYTES,
  TEXT_PREVIEW_MAX_BYTES,
  buildFilePreview,
  detectMimeType,
  type FilePreview,
} from '../../src/api/services/openclaw/file-preview'

/**
 * Contract suite for src/api/services/openclaw/file-preview.ts, the
 * helper module behind the `/claw/files/:id/preview` and
 * `/claw/files/:id/download` routes. It pins the behaviour that exists
 * today so the next change to the module has something to fail against.
 *
 * Export coverage: 4 exercised, 0 blocked (4 total).
 *
 *   - TEXT_PREVIEW_MAX_BYTES  — exercised below (documented cap value,
 *     snippet truncation boundary, `truncated` flag boundary).
 *   - IMAGE_PREVIEW_MAX_BYTES — exercised below (documented cap value,
 *     inline image vs metadata-only binary boundary).
 *   - detectMimeType          — exercised below (extension map,
 *     case-insensitive extensions, extension-over-magic precedence,
 *     magic-byte fallback, text heuristic, missing-file fallback).
 *   - buildFilePreview        — exercised below (all five preview kinds:
 *     missing, text, image, pdf, binary).
 *
 * Blocked exports: none. The module only touches the local filesystem,
 * so every export is pinned against temp files — no network, database,
 * or container is needed.
 */

/** First six bytes of every PNG file — what the magic-byte sniffer checks. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])

describe('filePreviewContract', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    )
    tempDirs.length = 0
  })

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'file-preview-test-'))
    tempDirs.push(dir)
    return dir
  }

  /** Narrows a preview to the expected kind, failing loudly otherwise. */
  function expectKind<K extends FilePreview['kind']>(
    preview: FilePreview,
    kind: K,
  ): Extract<FilePreview, { kind: K }> {
    if (preview.kind !== kind) {
      throw new Error(`expected "${kind}" preview, got "${preview.kind}"`)
    }
    return preview as Extract<FilePreview, { kind: K }>
  }

  describe('TEXT_PREVIEW_MAX_BYTES', () => {
    it('is the documented 1 MiB cap on inline text snippets', () => {
      expect(TEXT_PREVIEW_MAX_BYTES).toBe(1024 * 1024)
    })

    it('caps the snippet at the cap and flags the file as truncated beyond it', async () => {
      const dir = makeTempDir()
      const path = join(dir, 'long.txt')
      await writeFile(path, 'a'.repeat(TEXT_PREVIEW_MAX_BYTES + 1))

      const preview = expectKind(
        await buildFilePreview(path),
        'text',
      )

      expect(preview.size).toBe(TEXT_PREVIEW_MAX_BYTES + 1)
      expect(preview.snippet.length).toBe(TEXT_PREVIEW_MAX_BYTES)
      expect(preview.snippet).not.toContain('b')
      expect(preview.truncated).toBe(true)
    })

    it('does not flag a text file at exactly the cap as truncated', async () => {
      const dir = makeTempDir()
      const path = join(dir, 'exact.txt')
      await writeFile(path, 'b'.repeat(TEXT_PREVIEW_MAX_BYTES))

      const preview = expectKind(await buildFilePreview(path), 'text')

      expect(preview.snippet.length).toBe(TEXT_PREVIEW_MAX_BYTES)
      expect(preview.truncated).toBe(false)
    })
  })

  describe('IMAGE_PREVIEW_MAX_BYTES', () => {
    it('is the documented 4 MiB cap on inline image bytes', () => {
      expect(IMAGE_PREVIEW_MAX_BYTES).toBe(4 * 1024 * 1024)
    })

    it('still inlines an image at exactly the cap', async () => {
      const dir = makeTempDir()
      const path = join(dir, 'at-cap.png')
      await writeFile(
        path,
        Buffer.concat([
          PNG_MAGIC,
          Buffer.alloc(IMAGE_PREVIEW_MAX_BYTES - PNG_MAGIC.length, 1),
        ]),
      )

      const preview = await buildFilePreview(path)

      expectKind(preview, 'image')
    })

    it('downgrades an image over the cap to a metadata-only binary preview', async () => {
      const dir = makeTempDir()
      const path = join(dir, 'over-cap.png')
      await writeFile(
        path,
        Buffer.concat([PNG_MAGIC, Buffer.alloc(IMAGE_PREVIEW_MAX_BYTES, 1)]),
      )

      const preview = expectKind(await buildFilePreview(path), 'binary')

      expect(preview.mimeType).toBe('image/png')
      expect(preview.size).toBe(IMAGE_PREVIEW_MAX_BYTES + PNG_MAGIC.length)
      expect(preview).not.toHaveProperty('dataUrl')
    })
  })

  describe('detectMimeType', () => {
    it('maps known extensions to their MIME type, case-insensitively', async () => {
      const dir = makeTempDir()
      const markdown = join(dir, 'README.MD')
      await writeFile(markdown, '# hi')
      expect(await detectMimeType(markdown)).toBe('text/markdown')

      const jpeg = join(dir, 'photo.JpG')
      await writeFile(jpeg, Buffer.alloc(4, 1))
      expect(await detectMimeType(jpeg)).toBe('image/jpeg')

      const zip = join(dir, 'archive.zip')
      await writeFile(zip, Buffer.alloc(4, 1))
      expect(await detectMimeType(zip)).toBe('application/zip')
    })

    it('prefers the extension over contradicting magic bytes', async () => {
      const dir = makeTempDir()
      const path = join(dir, 'notes.txt')
      await writeFile(path, PNG_MAGIC)

      expect(await detectMimeType(path)).toBe('text/plain')
    })

    it('falls back to magic bytes when the extension is unknown', async () => {
      const dir = makeTempDir()

      const png = join(dir, 'snapshot')
      await writeFile(png, Buffer.concat([PNG_MAGIC, Buffer.alloc(8, 1)]))
      expect(await detectMimeType(png)).toBe('image/png')

      const jpeg = join(dir, 'picture')
      await writeFile(jpeg, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))
      expect(await detectMimeType(jpeg)).toBe('image/jpeg')

      const gif = join(dir, 'animation')
      await writeFile(gif, Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))
      expect(await detectMimeType(gif)).toBe('image/gif')

      const webp = join(dir, 'sticker')
      await writeFile(
        webp,
        Buffer.from([
          0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
        ]),
      )
      expect(await detectMimeType(webp)).toBe('image/webp')

      const pdf = join(dir, 'document')
      await writeFile(pdf, '%PDF-1.4\n')
      expect(await detectMimeType(pdf)).toBe('application/pdf')
    })

    it('sniffs plain text and rejects NUL-containing heads for unknown files', async () => {
      const dir = makeTempDir()

      const text = join(dir, 'CHANGELOG')
      await writeFile(text, 'fixed a thing')
      expect(await detectMimeType(text)).toBe('text/plain')

      const empty = join(dir, 'empty')
      await writeFile(empty, '')
      expect(await detectMimeType(empty)).toBe('text/plain')

      const binary = join(dir, 'blob')
      await writeFile(binary, Buffer.from([0x00, 0x01, 0x02]))
      expect(await detectMimeType(binary)).toBe('application/octet-stream')
    })

    it('reports an unreadable (missing) path as a generic binary stream', async () => {
      const dir = makeTempDir()
      const missing = join(dir, 'does-not-exist.bin')

      expect(await detectMimeType(missing)).toBe('application/octet-stream')
    })
  })

  describe('buildFilePreview', () => {
    it('reports a missing file as kind "missing" and nothing else', async () => {
      const dir = makeTempDir()
      const missing = join(dir, 'no-such-file.txt')

      expect(await buildFilePreview(missing)).toEqual({ kind: 'missing' })
    })

    it('returns the decoded snippet and file metadata for a text file', async () => {
      const dir = makeTempDir()
      const path = join(dir, 'notes.md')
      await writeFile(path, '# Hello\n\nWorld')

      const preview = expectKind(await buildFilePreview(path), 'text')

      expect(preview.mimeType).toBe('text/markdown')
      expect(preview.snippet).toBe('# Hello\n\nWorld')
      expect(preview.size).toBe(14)
      expect(preview.truncated).toBe(false)
      expect(preview.mtimeMs).toBeGreaterThan(0)
    })

    it('treats JSON — a non-text/* MIME — as previewable text', async () => {
      const dir = makeTempDir()
      const path = join(dir, 'data.json')
      await writeFile(path, '{"a":1}')

      const preview = expectKind(await buildFilePreview(path), 'text')

      expect(preview.mimeType).toBe('application/json')
      expect(preview.snippet).toBe('{"a":1}')
    })

    // NOTE: the module's inline comment on `isImageMime` says SVG "is
    // text — let it go through the text path", but `isTextMime` has no
    // entry for `image/svg+xml`, so the observable behaviour today is a
    // metadata-only binary preview. This suite pins the behaviour, not
    // the comment.
    it('routes SVG to the metadata-only binary preview path', async () => {
      const dir = makeTempDir()
      const path = join(dir, 'icon.svg')
      await writeFile(path, '<svg xmlns="http://www.w3.org/2000/svg"></svg>')

      const preview = expectKind(await buildFilePreview(path), 'binary')

      expect(preview.mimeType).toBe('image/svg+xml')
      expect(preview.size).toBe(
        '<svg xmlns="http://www.w3.org/2000/svg"></svg>'.length,
      )
      expect(preview).not.toHaveProperty('snippet')
      expect(preview).not.toHaveProperty('dataUrl')
    })

    it('returns a PDF preview with metadata only — no snippet or data URL', async () => {
      const dir = makeTempDir()
      const path = join(dir, 'manual.pdf')
      const bytes = Buffer.from('%PDF-1.4\n% browseros test\n')
      await writeFile(path, bytes)

      const preview = expectKind(await buildFilePreview(path), 'pdf')

      expect(preview.mimeType).toBe('application/pdf')
      expect(preview.size).toBe(bytes.length)
      expect(preview.mtimeMs).toBeGreaterThan(0)
      expect(preview).not.toHaveProperty('snippet')
      expect(preview).not.toHaveProperty('dataUrl')
    })

    it('returns an <img>-ready data URL that decodes back to the file bytes', async () => {
      const dir = makeTempDir()
      const path = join(dir, 'avatar.png')
      const bytes = Buffer.concat([
        PNG_MAGIC,
        Buffer.from([0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe]),
      ])
      await writeFile(path, bytes)

      const preview = expectKind(await buildFilePreview(path), 'image')

      expect(preview.mimeType).toBe('image/png')
      expect(preview.size).toBe(bytes.length)
      expect(preview.dataUrl.startsWith('data:image/png;base64,')).toBe(
        true,
      )
      const payload = preview.dataUrl.slice('data:image/png;base64,'.length)
      expect(Buffer.from(payload, 'base64').equals(bytes)).toBe(true)
    })

    it('returns a metadata-only binary preview for non-previewable types', async () => {
      const dir = makeTempDir()
      const path = join(dir, 'archive.zip')
      await writeFile(path, Buffer.from([0x50, 0x4b, 0x03, 0x04]))

      const preview = expectKind(await buildFilePreview(path), 'binary')

      expect(preview.mimeType).toBe('application/zip')
      expect(preview.size).toBe(4)
      expect(preview.mtimeMs).toBeGreaterThan(0)
      expect(preview).not.toHaveProperty('snippet')
      expect(preview).not.toHaveProperty('dataUrl')
    })
  })
})
