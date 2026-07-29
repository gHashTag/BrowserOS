#!/usr/bin/env bun
import { parseArgs } from 'node:util'
import { createR2Client, getBucket, putFile } from './common/r2'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    file: { type: 'string' },
    key: { type: 'string' },
    'content-type': { type: 'string' },
  },
})

if (!values.file || !values.key) {
  throw new Error('--file and --key required')
}

const contentType = values['content-type'] ?? 'application/octet-stream'
const client = createR2Client()
const bucket = getBucket()

try {
  await putFile(client, bucket, values.key, values.file, contentType)
  console.log(`uploaded ${values.file} to ${bucket}/${values.key}`)
} finally {
  client.destroy()
}
