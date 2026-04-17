#!/usr/bin/env node
/**
 * A2A Client v3 - отправляет сообщения через порт 3000
 */

const WebSocket = require('ws')

const WS_URL = 'ws://127.0.0.1:3000/a2a/ws'
const CONVERSATION_ID = 'claude-assistant-' + Date.now()

let ws = null
let isReady = false

// При подключении отправляем сообщение готовности
function onOpen() {
  console.log('✅ WebSocket подключен к порту 3000')
  ws.send(JSON.stringify({
    type: 'ready'
  }))
}

// Обработка сообщений от сервера
function onMessage(data) {
  try {
    const msg = JSON.parse(data)

    if (msg.type === 'sse' && msg.event) {
      if (msg.event.type === 'text-delta') {
        // Печатаем текст сообщения от ассистента
        process.stdout.write(msg.event.textDelta)
      } else if (msg.event.type === 'done') {
        console.log('\n✓ Генерация завершена')
      } else if (msg.event.type === 'error') {
        console.log('\n❌ Ошибка ассистента:', msg.event.message)
      }
    }
  } else if (msg.type === 'ready') {
      isReady = true
    }
  } catch (e) {
    // Игнорируем ошибки парсинга
  }
}

// Подключение к WebSocket
function connect() {
  ws = new WebSocket(WS_URL)

  ws.on('open', onOpen)
  ws.on('message', onMessage)
  ws.on('error', (error) => {
    console.error('❌ WebSocket ошибка:', error.message)
    process.exit(1)
  })
  ws.on('close', () => {
    console.log('🔌 WebSocket закрыт')
    process.exit(0)
  })
}

// Запуск
console.log('📤 Подключение к A2A (порт 3000)...')
connect()
