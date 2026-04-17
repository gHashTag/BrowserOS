#!/usr/bin/env bun
/**
 * Минимальный тест для chat endpoint
 */

async function testChat() {
  const response = await fetch('http://127.0.0.1:9000/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: 'Тестовое сообщение',
      role: 'user',
      agentName: 'TestAgent',
    }),
  })

  console.log('Status:', response.status)
  console.log('Headers:', Object.fromEntries(response.headers.entries()))
  const text = await response.text()
  console.log('Response:', text.substring(0, 500))
}

testChat()
