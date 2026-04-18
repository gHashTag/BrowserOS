/**
 * @license AGPL-3.0-or-later
 * Copyright 2025 TRIOS
 *
 * Terminal Pane
 * Embedded terminal with xterm.js for Git operations
 */

import { Loader2, Terminal } from 'lucide-react'
import type { FC } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'

interface TerminalPaneProps {
  repositoryPath: string
}

export const TerminalPane: FC<TerminalPaneProps> = ({ repositoryPath }) => {
  const [command, setCommand] = useState('')
  const [output, setOutput] = useState<string[]>([
    `Git Terminal initialized for: ${repositoryPath}`,
    'Type git commands or use the quick actions below.',
    '',
  ])
  const [isExecuting, setIsExecuting] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [output])

  const executeCommand = async (cmd: string) => {
    if (!cmd.trim()) return

    setIsExecuting(true)
    setOutput((prev) => [...prev, `$ ${cmd}`])

    try {
      const response = await fetch('/api/terminal/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: cmd,
          workingDir: repositoryPath,
        }),
      })

      const result = await response.json()

      if (result.success) {
        setOutput((prev) => [...prev, result.output || 'Command completed'])
      } else {
        setOutput((prev) => [...prev, `Error: ${result.error}`])
      }
    } catch (error) {
      setOutput((prev) => [
        ...prev,
        `Error: Failed to execute command: ${String(error)}`,
      ])
    } finally {
      setIsExecuting(false)
      setCommand('')
    }
  }

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      executeCommand(command)
    }
  }

  const quickCommands = [
    { label: 'Status', cmd: 'git status' },
    { label: 'Log', cmd: 'git log --oneline -10' },
    { label: 'Diff', cmd: 'git diff' },
    { label: 'Branch', cmd: 'git branch -a' },
  ]

  return (
    <div className="flex h-full flex-col">
      <Card className="flex-1 overflow-hidden">
        <CardHeader className="flex flex-row items-center justify-between border-b py-2">
          <div className="flex items-center gap-2">
            <Terminal className="size-4 text-muted-foreground" />
            <span className="text-sm font-medium">Terminal</span>
          </div>
          <div className="flex gap-1">
            {quickCommands.map((qc) => (
              <Button
                key={qc.cmd}
                variant="ghost"
                size="sm"
                className="h-6 text-xs"
                onClick={() => executeCommand(qc.cmd)}
              >
                {qc.label}
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col p-0">
          <ScrollArea className="flex-1 p-4">
            <div ref={scrollRef} className="font-mono text-sm space-y-1">
              {output.map((line, i) => (
                <div key={i} className="whitespace-pre-wrap">
                  {line.startsWith('$') ? (
                    <span className="text-green-500">{line}</span>
                  ) : line.startsWith('Error:') ? (
                    <span className="text-red-500">{line}</span>
                  ) : (
                    <span className="text-muted-foreground">{line}</span>
                  )}
                </div>
              ))}
              {isExecuting && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  <span>Executing...</span>
                </div>
              )}
            </div>
          </ScrollArea>

          <div className="flex items-center gap-2 border-t p-2">
            <span className="text-muted-foreground text-sm">$</span>
            <Input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={handleKeyPress}
              placeholder="Enter git command..."
              className="flex-1 font-mono text-sm"
              disabled={isExecuting}
            />
            <Button
              size="sm"
              onClick={() => executeCommand(command)}
              disabled={isExecuting}
            >
              Run
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
