import type { AclRule, ElementProperties } from '../types/acl'

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'any',
  'avoid',
  'be',
  'block',
  'browseros',
  'button',
  'buttons',
  'can',
  'do',
  'from',
  'for',
  'let',
  'me',
  'never',
  'not',
  'of',
  'on',
  'or',
  'prevent',
  'should',
  'stop',
  'the',
  'this',
  'to',
])

const INTENT_EXPANSIONS = [
  {
    triggers: ['pay', 'payment', 'payments', 'checkout', 'purchase', 'buy'],
    terms: [
      'pay',
      'payment',
      'payments',
      'checkout',
      'proceed to checkout',
      'continue to checkout',
      'place order',
      'place your order',
      'submit order',
      'buy now',
      'purchase',
    ],
  },
  {
    triggers: ['send', 'email', 'mail', 'message'],
    terms: [
      'send',
      'send email',
      'send message',
      'compose',
      'new message',
      'send now',
    ],
  },
  {
    triggers: ['delete', 'remove', 'trash'],
    terms: ['delete', 'remove', 'trash', 'confirm delete'],
  },
  {
    triggers: ['submit', 'save', 'confirm', 'approve'],
    terms: ['submit', 'save', 'confirm', 'approve'],
  },
]

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function sitePatternToRegex(pattern: string): RegExp {
  const slashIdx = pattern.indexOf('/')
  const hostPart = slashIdx === -1 ? pattern : pattern.slice(0, slashIdx)
  const pathPart = slashIdx === -1 ? '' : pattern.slice(slashIdx)

  const escapeAndGlob = (s: string, slashWild: boolean) =>
    s
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '{{GLOBSTAR}}')
      .replace(/\*/g, slashWild ? '.*' : '[^./]*')
      .replace(/\?/g, '.')
      .replace(/\{\{GLOBSTAR\}\}/g, '.*')

  const hostRegex = escapeAndGlob(hostPart, false)
  const pathRegex = pathPart ? escapeAndGlob(pathPart, true) : '(?:/.*)?'

  return new RegExp(`^${hostRegex}${pathRegex}$`, 'i')
}

function extractHostTerms(pattern: string): Set<string> {
  const host = pattern.split('/')[0] ?? pattern
  const normalized = normalizeText(host.replace(/\*/g, ' '))
  return new Set(
    normalized
      .split(/\s+/)
      .map((term) => term.trim())
      .filter((term) => term.length >= 3),
  )
}

export function matchesSitePattern(url: string, pattern: string): boolean {
  if (!pattern) return false
  if (pattern === '*') return true
  try {
    const { hostname } = new URL(url)

    const isSimpleDomain = !pattern.includes('*') && !pattern.includes('/')
    if (isSimpleDomain) {
      return hostname === pattern || hostname.endsWith(`.${pattern}`)
    }

    const fullPath = hostname + new URL(url).pathname
    return sitePatternToRegex(pattern).test(fullPath)
  } catch {
    return false
  }
}

export function compileAclTerms(rule: AclRule): string[] {
  const terms: string[] = []

  if (rule.textMatch) {
    const normalized = normalizeText(rule.textMatch)
    if (normalized) terms.push(normalized)
  }

  const hostTerms = extractHostTerms(rule.sitePattern)
  const intentText = normalizeText(rule.description ?? '')
  if (intentText) {
    const rawTerms = intentText
      .split(/\s+/)
      .map((term) => term.trim())
      .filter((term) => term.length >= 3)
      .filter((term) => !STOP_WORDS.has(term))
      .filter((term) => !hostTerms.has(term))

    terms.push(...rawTerms)

    for (const expansion of INTENT_EXPANSIONS) {
      if (rawTerms.some((term) => expansion.triggers.includes(term))) {
        terms.push(...expansion.terms.map(normalizeText))
      }
    }
  }

  return dedupe(terms)
}

function buildSearchText(props: ElementProperties): string {
  return normalizeText(
    [
      props.labelText,
      props.ariaLabel,
      props.textContent,
      props.attributes.placeholder,
      props.attributes.title,
      props.attributes.name,
      props.attributes.value,
      props.attributes.id,
      props.role,
    ]
      .filter(Boolean)
      .join(' '),
  )
}

export function matchesElement(
  props: ElementProperties,
  rule: AclRule,
): boolean {
  if (!rule.selector && !rule.textMatch && !rule.description) return false

  if (rule.selector && !selectorMatchesProps(rule.selector, props)) {
    return false
  }

  const compiledTerms = compileAclTerms(rule)
  if (compiledTerms.length === 0) {
    return Boolean(rule.selector)
  }

  const searchText = buildSearchText(props)
  return compiledTerms.some((term) => searchText.includes(term))
}

function selectorMatchesProps(
  selector: string,
  props: ElementProperties,
): boolean {
  const tag = props.tagName.toLowerCase()
  const id = props.attributes.id
  const classes = (props.attributes.class ?? '').split(/\s+/).filter(Boolean)

  const parts = selector.split(',').map((s) => s.trim())
  return parts.some((part) => {
    if (part.startsWith('#') && id) return part === `#${id}`
    if (part.startsWith('.')) return classes.some((c) => part === `.${c}`)
    const tagMatch = part.match(/^(\w+)/)
    if (tagMatch) return tagMatch[1].toLowerCase() === tag
    return false
  })
}

export function findMatchingRules(
  url: string,
  props: ElementProperties,
  rules: AclRule[],
): AclRule[] {
  const siteRules = rules.filter(
    (r) => r.enabled && matchesSitePattern(url, r.sitePattern),
  )
  return siteRules.filter((r) => {
    if (!r.selector && !r.textMatch && !r.description) return true
    return matchesElement(props, r)
  })
}
