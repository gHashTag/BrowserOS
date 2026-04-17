#!/usr/bin/env bun
/**
 * A2A HTTP Client - отправляет сообщения через POST /chat endpoint
 */

const CHAT_URL = 'http://127.0.0.1:9000/chat'

async function sendMessage(text: string): Promise<void> {
  console.log(`📤 Отправка: ${text}`)

  const response = await fetch(CHAT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: text,
      role: 'user',
      agentName: 'ClaudeAssistant',
    }),
  })

  if (!response.ok) {
    console.error(`❌ Ошибка: ${response.status}`)
    const error = await response.text()
    console.error(error)
    return
  }

  console.log('✓ Отправлено!')

  // Логируем ответ для отладки
  const result = await response.text()
  console.log('📄 Ответ:', result.substring(0, 200) + '...')
}

const message = process.argv[2] || 'Привет! Это тестовое сообщение от Claude через A2A HTTP клиент.'

await sendMessage(message)
