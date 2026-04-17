#!/usr/bin/env bun
/**
 * A2A Bridge Client - отправляет сообщения из файла в BrowserOS
 */

// Временное решение для отладки - использовать правильный порт A2A (9001)
const WS_URL = 'ws://127.0.0.1:9001/a2a/ws'
const CONVERSATION_ID = 'claude-bridge-' + Date.now()
const MESSAGE_FILE = '/tmp/a2a-messages.txt'

console.log('='.repeat(60))
console.log('🤖 A2A Bridge Client')
console.log('='.repeat(60))
console.log('WebSocket URL:', WS_URL)
console.log('Conversation ID:', CONVERSATION_ID)
console.log('Message file:', MESSAGE_FILE)
console.log('='.repeat(60))

const ws = new WebSocket(WS_URL)
let isReady = false

// Создаем файл если не существует
await Bun.write(MESSAGE_FILE, '')

// Отправляем приветственное сообщение
ws.on('open', () => {
  console.log('\n✅ WebSocket подключен')
  isReady = true

  ws.send(JSON.stringify({
    type: 'chat',
    request: {
      message: 'Привет! Я ваш ассистент Claude через A2A мост.',
      role: 'assistant',
      agentName: 'ClaudeAssistant',
      conversationId: CONVERSATION_ID
    }
  }))
})

// Получаем сообщения от сервера
ws.on('message', async (data) => {
  let msg
  try {
    msg = JSON.parse(data) as { type: string; event?: any; message?: string }
  } catch {
    return
  }

  if (msg.type === 'ready') {
    isReady = true
  } else if (msg.type === 'sse' && msg.event?.type === 'text-delta') {
    process.stdout.write(msg.event.textDelta)
  } else if (msg.type === 'sse' && msg.event?.type === 'done') {
    console.log('\n✓ Генерация завершена')
  } else if (msg.type === 'error') {
    console.log('\n❌ Ошибка:', msg.message)
  }
})

ws.on('error', (error) => {
  console.log('\n❌ WebSocket ошибка:', error.message)
})

ws.on('close', () => {
  console.log('\n🔌 WebSocket закрыт')
  process.exit(0)
})

// Функция для отправки сообщения
async function sendMessage(text: string) {
  if (!isReady) {
    console.log('⏳ Ожидание готовности WebSocket...')
    await new Promise(resolve => setTimeout(resolve, 500))
  }

  console.log(`\n📤 Отправка: ${text}`)
  ws.send(JSON.stringify({
    type: 'chat',
    request: {
      message: text,
      role: 'user',
      agentName: 'ClaudeAssistant',
      conversationId: CONVERSATION_ID
    }
  }))
}

// Интерактивный режим: читаем ввод из терминала
console.log('\n📝 Интерактивный режим:')
console.log('Введите сообщение и нажмите Enter (или Ctrl+C для выхода)')
console.log('='.repeat(60))

const reader = Bun.stdin.stream('text')
const decoder = new TextDecoder()

for await (const chunk of reader) {
  const text = decoder.decode(chunk)
  if (text.trim()) {
    await sendMessage(text)
  }
}
