const readline = require('readline')
const WS_URL = 'ws://127.0.0.1:3001/a2a/ws'
const CONVERSATION_ID = 'test-' + Date.now()

console.log('Connecting to:', WS_URL)

const ws = new WebSocket(WS_URL)
let isReady = false
let fullResponse = ''

ws.on('open', () => {
  console.log('WebSocket connected')
  isReady = true
  ws.send(JSON.stringify({
    type: 'chat',
    request: {
      message: 'Hello test',
      role: 'assistant',
      agentName: 'TestAgent',
      conversationId: CONVERSATION_ID
    }
  }))
})

ws.on('message', (data) => {
  let msg = null
  try {
    msg = JSON.parse(data)
  } catch (e) {}

  if (!msg) return

  if (msg.type === 'sse') {
    if (msg.event.type === 'text-delta') {
      process.stdout.write(msg.event.textDelta)
      fullResponse += msg.event.textDelta
    } else if (msg.event.type === 'done') {
      console.log('Done! Full response:', fullResponse)
    }
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
})

rl.on('line', (input) => {
  ws.send(JSON.stringify({
    type: 'chat',
    request: {
      message: input,
      role: 'user',
      agentName: 'TestAgent',
      conversationId: CONVERSATION_ID
    }
  }))
})

rl.on('SIGINT', () => {
  ws.close()
  process.exit(0)
})
