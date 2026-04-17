#!/usr/bin/env node
/**
 * Тестовое сообщение для A2A через Node.js
 */

const WebSocket = require('ws')
const ws = new WebSocket('ws://127.0.0.1:3001/a2a/ws')

console.log('📤 Подключение к A2A WebSocket (порт 3001)...')

ws.on('open', () => {
  console.log('✅ WebSocket подключен!')

  // Отправляем сообщение
  ws.send(JSON.stringify({
    type: 'chat',
    request: {
      message: '🤖 Привет! Это тестовое сообщение от Claude через A2A мост. Интеграция работает!',
      role: 'user',
      agentName: 'ClaudeAssistant',
      conversationId: 'claude-test-' + Date.now()
    }
  }))
})

ws.on('message', (data) => {
  console.log('📄 Ответ от A2A:', data)
})

ws.on('error', (error) => {
  console.error('❌ Ошибка WebSocket:', error.message)
})

ws.on('close', () => {
  console.log('🔌 WebSocket закрыт')
})

console.log('Ждём ответа (5 секунд)...')

setTimeout(() => {
  ws.close()
  process.exit(0)
}, 5000)
