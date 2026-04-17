#!/usr/bin/env bun
/**
 * Отправка сообщения через A2A
 */

import { startClient, isClientReady, sendToClient } from '../lib/a2a-client'

const message = process.argv[2] || 'Привет! Тестовое сообщение от Claude.'

async function main() {
  console.log('📤 Подключение к A2A...')
  await startClient()

  if (!isClientReady()) {
    console.log('⏳ Ожидание готовности...')
    await new Promise(r => setTimeout(r, 5000))
  }

  console.log(`📤 Отправка: ${message}`)
  await sendToClient(message)
  console.log('✓ Отправлено!')
}

main().catch(console.error)
