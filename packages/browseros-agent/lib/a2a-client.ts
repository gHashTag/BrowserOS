/**
 * A2A Control Library - управление WebSocket клиентом для отправки сообщений (Bun compatible)
 */

const WS_URL = 'ws://127.0.0.1:9000/a2a/ws'
const CONVERSATION_ID = 'claude-assistant-' + Date.now()

let ws: WebSocket | null = null
let ready = false

/**
 * Запустить WebSocket клиент
 */
export async function startClient(): Promise<void> {
  if (ws?.readyState === WebSocket.OPEN) {
    ready = true
    return
  }

  return new Promise<void>((resolve, reject) => {
    ws = new WebSocket(WS_URL)

    // Используем присваивание свойств для WebSocket (Bun API)
    const socket = ws as any
    socket.addEventListener('open', () => {
      ready = true

      // Отправляем приветственное сообщение
      socket.send(JSON.stringify({
        type: 'chat',
        request: {
          message: 'A2A ассистент готов к работе.',
          role: 'assistant',
          agentName: 'ClaudeAssistant',
          conversationId: CONVERSATION_ID
        }
      }))
    })

    socket.addEventListener('message', (data: string) => {
      try {
        const msg = JSON.parse(data) as { type: string; event?: any; message?: string }

        if (msg.type === 'ready') {
          ready = true
        }
      } catch {
        // Игнорируем ошибки парсинга
      }
    })

    socket.addEventListener('error', (error: any) => {
      console.error('WebSocket error:', error?.message)
      reject(error)
    })

    socket.addEventListener('close', () => {
      ready = false
      ws = null
    })

    resolve()
  })
}

/**
 * Проверить готовность клиента
 */
export function isClientReady(): boolean {
  return ready && ws?.readyState === WebSocket.OPEN
}

/**
 * Получить URL WebSocket
 */
export function getWsUrl(): string {
  return WS_URL
}

/**
 * Получить ID беседы
 */
export function getConversationId(): string {
  return CONVERSATION_ID
}

/**
 * Отправить сообщение через WebSocket
 */
export async function sendToClient(text: string): Promise<void> {
  if (!isClientReady()) {
    console.log('⏳ Ожидание готовности...')
    for (let i = 0; i < 100; i++) {
      if (isClientReady()) break
      await new Promise(r => setTimeout(r, 100))
    }
  }

  if (!isClientReady()) {
    throw new Error('WebSocket не готов')
  }

  ws?.send(JSON.stringify({
    type: 'chat',
    request: {
      message: text,
      role: 'user',
      agentName: 'ClaudeAssistant',
      conversationId: CONVERSATION_ID
    }
  }))
}

/**
 * Закрыть соединение
 */
export function closeClient(): void {
  ws?.close()
  ws = null
  ready = false
}
