export interface CaptureContextConfig {
  serverUrl: string
  outputDir: string
  taskId: string
  initialPageId: number
  onEvent?: (taskId: string, event: Record<string, unknown>) => void
}
