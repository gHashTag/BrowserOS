#!/usr/bin/env bun
/**
 * A2A HTTP Client - отправляет сообщения через POST /chat endpoint с правильными параметрами
 */

const CHAT_URL = 'http://127.0.0.1:9000/chat'

async function sendMessage(text: string, conversationId?: string): Promise<void> {
  console.log(`📤 Отправка: ${text}`)

  const requestBody = {
    message: text,
    role: 'user',
    agentName: 'ClaudeAssistant',
  }

  // Добавляем optional параметры
  if (conversationId) {
    requestBody.conversationId = conversationId
  }

  console.log('📋 Тело запроса:', JSON.stringify(requestBody))

  const response = await fetch(CHAT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  })

  if (!response.ok) {
    console.error(`❌ Ошибка HTTP: ${response.status}`)
    const error = await response.text()
    console.error(error)
    return
  }

  console.log('✓ Отправлено!')

  // Логируем ответ для отладки
  const result = await response.text()
  console.log('📄 Ответ:', result.substring(0, 300) + '...')
}

const message = process.argv[2] || 'Привет от Claude через A2A!'
const conversationId = process.argv[3]

await sendMessage(message, conversationId)
