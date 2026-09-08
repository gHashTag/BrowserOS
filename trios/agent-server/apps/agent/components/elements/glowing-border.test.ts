import { describe, expect, it } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { GlowingBorder, GlowingElement } from './glowing-border'

/**
 * Contract suite for glowing-border.tsx, whose exports are GlowingBorder and
 * GlowingElement. Both exports are pinned by rendering them through
 * react-dom/server and asserting on the emitted markup, so the suite needs no
 * DOM, no network, no database and no container. The travelling animation
 * (positions advancing frame by frame) is driven by requestAnimationFrame and
 * only a live browser provides that clock; a static render pins the state
 * every mount starts from, which is the visible contract of this module. No
 * export needs a live dependency to exercise, so nothing is left uncovered.
 */

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

describe('glowingBorderTsxContract', () => {
  describe('GlowingBorder', () => {
    it('stretches an unfilled frame over the parent with forwarded radii and svg attributes, and mounts the child glow twice, centred and invisible, before the animation starts', () => {
      const beacon = React.createElement('em', null, 'beacon')

      const withRadii = renderToStaticMarkup(
        React.createElement(
          GlowingBorder,
          { rx: '12%', ry: '6%', 'aria-hidden': true },
          beacon,
        ),
      )
      const plain = renderToStaticMarkup(
        React.createElement(GlowingBorder, null, beacon),
      )

      // The frame is an svg that stretches to cover its parent (no square
      // aspect ratio) and accepts the caller's svg attributes.
      expect(withRadii).toContain(
        '<svg xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none" class="absolute h-full w-full" width="100%" height="100%" aria-hidden="true">',
      )
      // The frame draws one unfilled rectangle at full size, whose corners
      // take the radii the caller asked for...
      expect(withRadii).toContain(
        '<rect fill="none" width="100%" height="100%" rx="12%" ry="6%">',
      )
      // ...and fall back to square corners when no radii are given.
      expect(plain).toContain('<rect fill="none" width="100%" height="100%">')

      // The caller's glow child is mounted twice, once for each traveller.
      expect(countOccurrences(withRadii, '<em>beacon</em>')).toBe(2)
      // Each traveller sits centred on its point along the border path...
      expect(
        countOccurrences(withRadii, 'translateX(-50%) translateY(-50%)'),
      ).toBe(2)
      // ...and both start out invisible until the animation begins.
      expect(countOccurrences(withRadii, 'opacity:0')).toBe(2)
    })
  })

  describe('GlowingElement', () => {
    it('renders a fixed-size accent-orange radial glow dot at reduced opacity', () => {
      const markup = renderToStaticMarkup(React.createElement(GlowingElement))
      expect(markup).toBe(
        '<div class="h-20 w-20 bg-[radial-gradient(var(--accent-orange)_40%,transparent_60%)] opacity-[0.8]"></div>',
      )
    })
  })
})
