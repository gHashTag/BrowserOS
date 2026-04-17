#!/usr/bin/env node
/**
 * A2A Chat Client
 */

const readline = require('readline')

const WS_URL = 'ws://127.0.0.1:3001/a2a/ws'
const CONVERSATION_ID = 'claude-session-' + Date.now()

console.log('='.repeat(60))
console.log('🤖 A2A Chat Client')
console.log('='.repeat(60))
console.log('Подключение к:', WS_URL)
console.log('Conversation ID:', CONVERSATION_ID)
console.log('Введите сообщение и нажмите Enter')
console.log('='.repeat(60))

const ws = new WebSocket(WS_URL)
let isReady = false
let fullResponse = ''

ws.on('open', () => {
  console.log('\n✅ WebSocket подключен')
  isReady = true

  // Отправляем приветственное сообщение
  ws.send(JSON.stringify({
    type: 'chat',
    request: {
      message: 'Привет! Я твой ассистент-агент Claude.',
      role: 'assistant',
      agentName: 'ClaudeAssistant',
      conversationId: CONVERSATION_ID
    }
  }))
})

ws.on('message', (data) => {
  let msg
  try {
    msg = JSON.parse(data)
  } catch (e) {
    return
  }

  if (msg.type === 'sse') {
    if (msg.event.type === 'text-delta') {
      process.stdout.write(msg.event.textDelta)
      fullResponse += msg.event.textDelta
    } else if (msg.event.type === 'done') {
      console.log('\n✓ Генерация завершена')
      console.log('\n📄 Полный ответ:')
      console.log(fullResponse)
    } else if (msg.event.type === 'error') {
      console.log('\n❌ Ошибка:', msg.event.message)
    }
  } else if (msg.type === 'ready') {
    isReady = true
  }
})

ws.on('error', (error) => {
  console.log('\n❌ WebSocket ошибка:', error.message)
})

ws.on('close', () => {
  console.log('\n🔌 WebSocket закрыт')
  process.exit(0)
})

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
})

rl.on('line', (input) => {
  if (!input.trim()) return

  console.log('\n📤 Отправка:', input)

  if (!isReady) {
    console.log('⏳ Ожидание готовности WebSocket...')
    return
  }

  fullResponse = ''
  ws.send(JSON.stringify({
    type: 'chat',
    request: {
      message: input,
      role: 'user',
      agentName: 'ClaudeAssistant',
      conversationId: CONVERSATION_ID
    }
  }))
})

rl.on('SIGINT', () => {
  console.log('\n\n👋 Выход...')
  ws.close()
  rl.close()
  process.exit(0)
})
