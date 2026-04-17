const WebSocket = require('ws')
const ws = new WebSocket('ws://127.0.0.1:9000/a2a/ws')

ws.on('open', () => {
  console.log('✅ WebSocket подключен к порту 9000')
  ws.send(JSON.stringify({
    type: 'ready'
  }))
})

ws.on('message', (data) => {
  console.log('📄 Сообщение:', data)
})

ws.on('error', (error) => {
  console.error('❌ Ошибка:', error.message)
})

setTimeout(() => {
  console.log('📤 Тестовое сообщение от ассистента...')
  ws.send(JSON.stringify({
    type: 'chat',
    request: {
      message: 'Привет! Это тестовое сообщение от Claude через порт 9000.',
      role: 'user',
      agentName: 'ClaudeAssistant',
      conversationId: 'test-session-9000-' + Date.now()
    }
  }))
}, 2000)
