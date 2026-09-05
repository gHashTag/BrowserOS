import { describe, expect, it } from 'bun:test'
import {
  basenameOf,
  buildFileDownloadUrl,
  extensionOf,
  formatFileSize,
  inferFileKind,
} from './file-helpers'

/**
 * First contract suite for the pure helpers behind the artifact card
 * and the Outputs rail. All five exports of ./file-helpers are pure
 * functions, so every one of them is exercised directly below and no
 * export had to be left out: none needs a network, a database or a
 * container to observe its behaviour.
 *
 * Covered exports: inferFileKind, extensionOf, basenameOf,
 * formatFileSize, buildFileDownloadUrl.
 */
describe('fileHelpersContract', () => {
  it('inferFileKind classifies a path from its extension alone', () => {
    expect(inferFileKind('report.pdf')).toBe('pdf')
    expect(inferFileKind('avatar.png')).toBe('image')
    expect(inferFileKind('AVATAR.JPG')).toBe('image')
    expect(inferFileKind('notes.md')).toBe('text')
    expect(inferFileKind('src/index.tsx')).toBe('text')
    expect(inferFileKind('bundle.tar.gz')).toBe('binary')
    expect(inferFileKind('archive.zip')).toBe('binary')
    expect(inferFileKind('Makefile')).toBe('binary')
    expect(inferFileKind('docs.d/readme.txt')).toBe('text')
  })

  it('extensionOf returns the segment after the final dot of the file name', () => {
    expect(extensionOf('notes.txt')).toBe('txt')
    expect(extensionOf('bundle.tar.gz')).toBe('gz')
    expect(extensionOf('.eslintrc')).toBe('eslintrc')
    expect(extensionOf('dir.d/file')).toBe('')
    expect(extensionOf('name.')).toBe('')
    expect(extensionOf('no-extension')).toBe('')
  })

  it('basenameOf returns the final slash-delimited segment', () => {
    expect(basenameOf('notes.txt')).toBe('notes.txt')
    expect(basenameOf('a/b/c.txt')).toBe('c.txt')
    expect(basenameOf('/abs/root/file.json')).toBe('file.json')
    expect(basenameOf('dir/')).toBe('')
  })

  it('formatFileSize renders a byte count as display text', () => {
    expect(formatFileSize(0)).toBe('0 B')
    expect(formatFileSize(78)).toBe('78 B')
    expect(formatFileSize(1023)).toBe('1023 B')
    expect(formatFileSize(1024)).toBe('1.0 KB')
    expect(formatFileSize(340 * 1024)).toBe('340 KB')
    expect(formatFileSize(2.4 * 1024 * 1024)).toBe('2.4 MB')
    expect(formatFileSize(1024 ** 3)).toBe('1.0 GB')
    expect(formatFileSize(3 * 1024 ** 4)).toBe('3.0 TB')
    expect(formatFileSize(2048 * 1024 ** 4)).toBe('2048 TB')
    expect(formatFileSize(-1)).toBe('—')
    expect(formatFileSize(Number.NaN)).toBe('—')
    expect(formatFileSize(Number.POSITIVE_INFINITY)).toBe('—')
  })

  it('buildFileDownloadUrl yields the absolute per-file download URL', () => {
    expect(buildFileDownloadUrl('http://localhost:8802', 'file-42')).toBe(
      'http://localhost:8802/agents/files/file-42/download',
    )
    expect(buildFileDownloadUrl('https://api.example.dev', 'a/b c')).toBe(
      'https://api.example.dev/agents/files/a%2Fb%20c/download',
    )
  })
})
