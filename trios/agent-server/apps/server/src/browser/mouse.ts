import type { ProtocolApi } from '@browseros/cdp-protocol/protocol-api'
import { releaseHeldInput, type HeldInputRelease } from './keyboard'

export async function dispatchClick(
  session: ProtocolApi,
  x: number,
  y: number,
  button: string,
  clickCount: number,
  modifiers: number,
): Promise<void> {
  const btn = button as 'left' | 'middle' | 'right'
  await session.Input.dispatchMouseEvent({ type: 'mouseMoved', x, y })
  await session.Input.dispatchMouseEvent({
    type: 'mousePressed',
    x,
    y,
    button: btn,
    clickCount,
    modifiers,
  })
  await session.Input.dispatchMouseEvent({
    type: 'mouseReleased',
    x,
    y,
    button: btn,
    clickCount,
    modifiers,
  })
}

export async function dispatchHover(
  session: ProtocolApi,
  x: number,
  y: number,
): Promise<void> {
  await session.Input.dispatchMouseEvent({ type: 'mouseMoved', x, y })
}

export async function dispatchDrag(
  session: ProtocolApi,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  // Last position the renderer was confirmed to have been told about
  // (updated after each successful dispatch), so an emergency release
  // happens where the pointer actually is rather than where it was headed.
  let x = from.x
  let y = from.y

  // The button release is registered BEFORE the press is awaited: a CDP
  // dispatch that times out was still sent, so the button may be down in
  // the renderer even when the await rejects. The entry is dropped only
  // after the release on the happy path completes, so a failed release gets
  // a second attempt from the finally block.
  const held: HeldInputRelease[] = []

  try {
    await session.Input.dispatchMouseEvent({
      type: 'mouseMoved',
      x: from.x,
      y: from.y,
    })
    held.push(() =>
      session.Input.dispatchMouseEvent({
        type: 'mouseReleased',
        x,
        y,
        button: 'left',
        clickCount: 1,
      }),
    )
    await session.Input.dispatchMouseEvent({
      type: 'mousePressed',
      x: from.x,
      y: from.y,
      button: 'left',
      clickCount: 1,
    })
    await session.Input.dispatchMouseEvent({
      type: 'mouseMoved',
      x: to.x,
      y: to.y,
    })
    x = to.x
    y = to.y
    await session.Input.dispatchMouseEvent({
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
    })
    // The button is genuinely up now; drop the emergency release so the
    // finally block does not dispatch a second mouseReleased.
    held.length = 0
  } finally {
    // A dispatch above may have rejected with the button still down in the
    // renderer. Release it if so. releaseHeldInput never throws, so the
    // original error still reaches the caller.
    await releaseHeldInput(held)
  }
}

export async function dispatchScroll(
  session: ProtocolApi,
  x: number,
  y: number,
  deltaX: number,
  deltaY: number,
): Promise<void> {
  await session.Input.dispatchMouseEvent({
    type: 'mouseWheel',
    x,
    y,
    deltaX,
    deltaY,
  })
}
