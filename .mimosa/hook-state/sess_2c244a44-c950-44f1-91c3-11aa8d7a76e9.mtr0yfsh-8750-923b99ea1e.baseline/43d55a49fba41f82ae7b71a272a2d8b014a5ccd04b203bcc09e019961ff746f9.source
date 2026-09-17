export const CLADO_ACTION_PROVIDER = 'clado-action'

export const CLADO_PAGE_SCOPED_TOOLS = new Set<string>([
  'take_screenshot',
  'evaluate_script',
  'click',
  'click_at',
  'hover',
  'hover_at',
  'clear',
  'fill',
  'press_key',
  'type_at',
  'drag',
  'drag_at',
  'scroll',
  'handle_dialog',
  'select_option',
  'navigate_page',
  'close_page',
  'wait_for',
])

export interface CladoActionResponse {
  action?: string | null
  x?: number
  y?: number
  text?: string
  key?: string
  direction?: string
  startX?: number
  startY?: number
  endX?: number
  endY?: number
  amount?: number
  time?: number
  final_answer?: string | null
  inference_time_seconds?: number
  raw_response?: string
  thinking?: string | null
  parse_error?: string | null
}

export interface CladoViewport {
  width: number
  height: number
}

export interface CladoAction {
  action: string
  x?: number
  y?: number
  text?: string
  key?: string
  direction?: string
  startX?: number
  startY?: number
  endX?: number
  endY?: number
  amount?: number
  time?: number
  final_answer?: string
}

export type RawCladoActionPayload = Partial<
  Omit<CladoAction, 'final_answer'>
> & {
  final_answer?: string | null
}

export interface CladoActionPoint {
  x: number
  y: number
}

export function isCladoActionProvider(provider: string): boolean {
  return provider === CLADO_ACTION_PROVIDER
}
