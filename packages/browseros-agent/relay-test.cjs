#!/usr/bin/env node
/**
 * Простой тест для A2A чата
 * Отправляет сообщение в чат и отслеживает ответ
 */

const WebSocket = require('ws')

const WS_URL = 'ws://127.0.0.1:3000/a2a/ws'
const CONVERSATION_ID = 'test-conversation-' + Date.now()

console.log(`Подключение к ${WS_URL}...`)

const ws = new WebSocket(WS_URL)

ws.on('open', () => {
  console.log('✅ WebSocket подключен')

  // Отправляем тестовое сообщение
  ws.send(JSON.stringify({
    type: 'chat',
    request: {
      message: 'Привет! Я - тестовый агент.',
      role: 'assistant',
      agentName: 'RelayObserver',
    },
  }))
})

ws.on('message', (data) => {
  try {
    const msg = JSON.parse(data)
    console.log('📩 Получено сообщение:', JSON.stringify(msg, null, 2))

    if (msg.type === 'sse') {
      if (msg.event.type === 'text-delta') {
        process.stdout.write(msg.event.textDelta)
      } else if (msg.event.type === 'done') {
        console.log('\n✅ Генерация завершена')
      }
    }
  } catch (e) {
    console.log('❌ Ошибка парсинга:', data)
  }
})

ws.on('error', (error) => {
  console.log('❌ WebSocket ошибка:', error.message)
})

ws.on('close', () => {
  console.log('🔌 WebSocket закрыт')
  process.exit(0)
})

// Обработка прерывания
process.on('SIGINT', () => {
  ws.close()
  process.exit(0)
})
