const WebSocket = require('ws')
const ws = new WebSocket('ws://127.0.0.1:9000/a2a/ws')

ws.on('open', () => {
  console.log('✅ WebSocket подключен')
})

ws.on('message', (data) => {
  console.log('📄 Сообщение:', data)
})

ws.on('error', (error) => {
  console.error('❌ Ошибка:', error.message)
})

ws.on('close', () => {
  console.log('🔌 Закрыто')
})

console.log('Ждём сообщений (каждые 5 секунд)...')
setInterval(() => {
  ws.send(JSON.stringify({
    type: 'chat',
    request: {
      message: 'Тест от WebSocket клиента!',
      role: 'user',
      agentName: 'ClaudeAssistant',
      conversationId: 'test-session-' + Date.now()
    }
  }))
}, 5000)
