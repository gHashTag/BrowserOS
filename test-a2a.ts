#!/usr/bin/env bun
/**
 * Тест A2A соединения
 */

const { startClient, isClientReady, sendToClient } = './packages/browseros-agent/lib/a2a-control.ts'

async function main() {
  console.log('Запуск A2A клиента...')
  await startClient()

  console.log('Готовность:', isClientReady())

  if (!isClientReady()) {
    console.log('Ожидание готовности...')
    await new Promise(r => setTimeout(r, 5000))
  }

  console.log('Отправка тестового сообщения...')
  await sendToClient('🤖 Привет из Claude через A2A мост! Это сообщение должно появиться в чате BrowserOS.')
  console.log('✓ Сообщение отправлено!')
}

main().catch(console.error)
