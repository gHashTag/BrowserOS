#!/usr/bin/env bun
/**
 * A2A Control Interface - управляет WebSocket клиентом для отправки сообщений
 */

import { sendToClient, startClient, isClientReady } from './packages/browseros-agent/lib/a2a-control'

async function main() {
  console.log('='.repeat(60))
  console.log('🤖 A2A Control Interface')
  console.log('='.repeat(60))

  if (!isClientReady()) {
    console.log('⏳ Запуск клиента...')
    await startClient()
  }

  console.log('✅ Клиент готов для отправки сообщений')
  console.log('='.repeat(60))
  console.log('Доступные команды:')
  console.log('  send <текст>     - отправить сообщение через A2A')
  console.log('  status               - проверить статус подключения')
  console.log('  exit                 - завершить работу')
  console.log('='.repeat(60))
}

const args = process.argv.slice(2)
const command = args[0]

if (!command || ['send', 'status', 'exit'].includes(command)) {
  main()
    process.exit(0)
}

switch (command) {
  case 'send':
    if (args[1]) {
      console.log(`\n📤 Отправка: ${args[1]}`)
      await sendToClient(args[1])
    } else {
      console.error('Ошибка: укажите текст сообщения')
    }
    break

  case 'status':
    if (isClientReady()) {
      console.log('✅ Подключено')
      console.log(`   WS URL: ws://127.0.0.1:9000/a2a/ws`)
      console.log(`   Ready: ${isClientReady()}`)
    } else {
      console.log('❌ Не подключено')
    }
    break

  case 'exit':
    console.log('\n👋 Завершение работы...')
    process.exit(0)
}

main()
