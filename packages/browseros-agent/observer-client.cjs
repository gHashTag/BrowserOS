#!/usr/bin/env node
/**
 * A2A Chat Observer
 *
 * Наблюдает сообщения в чате NotebookLM
 * Отвечает на behalf of user (simple echo mode)
 */

const readline = require('readline')
const CONVERSATION_ID = 'observer-' + Date.now()

console.log('='.repeat(60))
console.log('🤖 A2A Chat Observer')
console.log('='.repeat(60))
console.log(`Conversation ID: ${CONVERSATION_ID}`)
console.log('Откройте чат A2A: http://127.0.0.1:3001/a2a`)
console.log('Я буду наблюдать за вашими сообщениями.')
console.log('='.repeat(60))
console.log('Команды:')
console.log('  - Напишите сообщение и нажмите Enter')
console.log('  - Или введите команду:')
console.log('='.repeat(60))

const ws = new WebSocket('ws://127.0.0.1:3001/a2a/ws')
let isConnected = false
let isReady = false
let messageBuffer = ''

ws.on('open', () => {
  console.log('\n✅ WebSocket подключен к A2A')
  isConnected = true

  // Отправляем приветственное сообщение
  setTimeout(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'chat',
        request: {
          message: 'Привет! Я ваш ассистент-агент Claude. Наблюдаю за чатом.',
          role: 'assistant',
          agentName: 'ObserverAgent',
          conversationId: CONVERSATION_ID
        }
      }))
    }
  }, 500)
})

ws.on('message', (data) => {
  try {
    const msg = JSON.parse(data)

    if (msg.type === 'sse') {
      if (msg.event.type === 'text-delta') {
        process.stdout.write(msg.event.textDelta)
      } else if (msg.event.type === 'done') {
        console.log('\n✓ Генерация завершена\n')
      }
    }
  } catch (e) {
    return
  }

  if (msg.type === 'ready') {
    console.log('\n✅ Готов к приёму сообщений')
    isReady = true
  }
})

ws.on('error', (error) => {
  console.log(`\n❌ WebSocket ошибка: ${error.message}`)
  isConnected = false
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

  console.log(`\n📤 Сообщение: ${input}`)

  if (!isReady) {
    console.log('⏳ Ожидание готовности WebSocket...')
    return
  }

  // Отправляем в A2A
  ws.send(JSON.stringify({
    type: 'chat',
    request: {
      message: input,
      role: 'user',
      agentName: 'ObserverAgent',
      conversationId: CONVERSATION_ID
    }
  }))
})

console.log('\nКоманды:')
console.log('  1. Просто отправляйте сообщения')
console.log('  2. Для операций:')
console.log('   - "сделай Х" — я выполню команду')
console.log('='.repeat(60))
