import { describe, expect, test } from 'bun:test'

import {
  buildCliReleaseManifest,
  parseCliArchiveFilename,
  parseCliChecksums,
} from './upload'

describe('parseCliChecksums', () => {
  test('parses checksum lines into a filename map', () => {
    const checksums = parseCliChecksums(
      [
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  trios-cli_1.2.3_darwin_arm64.tar.gz',
        'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB *trios-cli_1.2.3_windows_amd64.zip',
      ].join('\n'),
    )

    expect(checksums.get('trios-cli_1.2.3_darwin_arm64.tar.gz')).toBe(
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    )
    expect(checksums.get('trios-cli_1.2.3_windows_amd64.zip')).toBe(
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    )
  })

  test('rejects malformed checksum lines', () => {
    expect(() => parseCliChecksums('not-a-checksum')).toThrow(
      'Invalid checksum line',
    )
  })
})

describe('parseCliArchiveFilename', () => {
  test('parses tar.gz archives', () => {
    expect(
      parseCliArchiveFilename('trios-cli_1.2.3_darwin_arm64.tar.gz'),
    ).toEqual({
      filename: 'trios-cli_1.2.3_darwin_arm64.tar.gz',
      version: '1.2.3',
      os: 'darwin',
      arch: 'arm64',
      archive_format: 'tar.gz',
    })
  })

  test('returns null for unexpected names', () => {
    expect(parseCliArchiveFilename('checksums.txt')).toBeNull()
  })
})

describe('buildCliReleaseManifest', () => {
  test('builds versioned asset URLs from archive names and checksums', () => {
    const manifest = buildCliReleaseManifest({
      version: '1.2.3',
      filenames: [
        'trios-cli_1.2.3_windows_arm64.zip',
        'trios-cli_1.2.3_darwin_arm64.tar.gz',
      ],
      checksumsContent: [
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  trios-cli_1.2.3_darwin_arm64.tar.gz',
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  trios-cli_1.2.3_windows_arm64.zip',
      ].join('\n'),
      published_at: '2026-03-27T19:00:00Z',
      cdnBaseURL: 'https://cdn.example.com',
      uploadPrefix: 'cli',
    })

    expect(manifest).toEqual({
      version: '1.2.3',
      published_at: '2026-03-27T19:00:00Z',
      tag: 'trios-cli-v1.2.3',
      assets: {
        'darwin/arm64': {
          filename: 'trios-cli_1.2.3_darwin_arm64.tar.gz',
          url: 'https://cdn.example.com/cli/v1.2.3/trios-cli_1.2.3_darwin_arm64.tar.gz',
          archive_format: 'tar.gz',
          sha256:
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
        'windows/arm64': {
          filename: 'trios-cli_1.2.3_windows_arm64.zip',
          url: 'https://cdn.example.com/cli/v1.2.3/trios-cli_1.2.3_windows_arm64.zip',
          archive_format: 'zip',
          sha256:
            'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
      },
    })
  })

  test('rejects archives without matching checksums', () => {
    expect(() =>
      buildCliReleaseManifest({
        version: '1.2.3',
        filenames: ['trios-cli_1.2.3_linux_amd64.tar.gz'],
        checksumsContent: '',
      }),
    ).toThrow('Missing checksum')
  })
})
