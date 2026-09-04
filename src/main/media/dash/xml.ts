/**
 * A very small XML reader, for MPD manifests and nothing else.
 *
 * ## Why not a library
 *
 * An MPD is a strict, shallow, well-known shape: a handful of element names,
 * attributes that are all simple strings, and text content in exactly one place
 * (`BaseURL`). A general XML parser brings entity expansion, DTDs, namespaces
 * and processing instructions — every one of which is attack surface for a
 * document fetched from a site the user merely visited, and none of which an
 * MPD needs. The billion-laughs class of attack exists precisely because
 * parsers are helpful about entities.
 *
 * So this reads elements, attributes and text, and **refuses** everything else:
 * no entity definitions, no DTD, no external references. `<!DOCTYPE` is skipped
 * rather than interpreted, and the five predefined entities are the only ones
 * expanded.
 *
 * ## Bounded on purpose
 *
 * A manifest is downloaded from a page. Depth, node count and document size are
 * all capped, and exceeding a cap is a refusal with a reason rather than a
 * crash — see `XML_LIMITS`. A parser with no ceiling on nesting is a stack
 * overflow waiting for a hostile file.
 */

/** Ceilings that keep a hostile manifest from being a denial of service. */
export const XML_LIMITS = {
  /** Nesting depth. A real MPD is about six deep. */
  maxDepth: 32,
  /** Elements in one document. A large multi-quality MPD is a few thousand. */
  maxNodes: 50_000,
  /** Characters. 8 MB of manifest is already absurd. */
  maxLength: 8 * 1024 * 1024
} as const

export interface XmlNode {
  readonly name: string
  readonly attributes: Readonly<Record<string, string>>
  readonly children: XmlNode[]
  /** Direct text content, trimmed. Empty when the element has none. */
  readonly text: string
}

export type XmlResult = { ok: true; root: XmlNode } | { ok: false; reason: string }

/** `xmlns:cenc` prefixes are noise here — `cenc:pssh` and `pssh` are the same element. */
function localName(raw: string): string {
  const colon = raw.lastIndexOf(':')
  return colon === -1 ? raw : raw.slice(colon + 1)
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'"
}

/**
 * Expands only the five predefined entities and numeric character references.
 *
 * Anything else is left as written. An unknown entity in a downloaded manifest
 * is either a mistake or an attempt to make the parser fetch something, and
 * neither deserves to be resolved.
 */
export function decodeText(raw: string): string {
  return raw.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body.startsWith('#x') || body.startsWith('#X')
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10)
      // Surrogates and out-of-range values are left alone rather than turned
      // into replacement characters that would silently corrupt a URL.
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body] ?? whole
  })
}

/** `a="1" b='2' c=3` → `{ a: '1', b: '2', c: '3' }`. */
export function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  const pattern = /([A-Za-z_:][-\w:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source)) !== null) {
    const name = match[1]
    if (name === undefined) continue
    const value = match[3] ?? match[4] ?? ''
    attributes[localName(name)] = decodeText(value)
  }
  return attributes
}

/**
 * Reads a document into a tree, or says why it could not.
 *
 * Iterative rather than recursive: the depth cap makes a stack overflow
 * impossible either way, but a loop keeps the failure a returned reason instead
 * of a thrown `RangeError` from somewhere inside the parser.
 */
export function parseXml(source: string): XmlResult {
  if (source.length > XML_LIMITS.maxLength) {
    return { ok: false, reason: 'This manifest is too large to read safely.' }
  }
  // A DTD can define entities, and entity expansion is the whole billion-laughs
  // attack. Refused outright rather than skipped, because a manifest that needs
  // one is not a manifest we should be reading.
  if (/<!DOCTYPE/i.test(source)) {
    return { ok: false, reason: 'This manifest declares a document type, which Slash does not read.' }
  }

  const root: XmlNode = { name: '#document', attributes: {}, children: [], text: '' }
  const stack: XmlNode[] = [root]
  let nodes = 0
  let cursor = 0

  while (cursor < source.length) {
    const open = source.indexOf('<', cursor)
    if (open === -1) break

    // Text belonging to the element currently open.
    if (open > cursor) {
      const parent = stack[stack.length - 1]
      if (parent && parent !== root) {
        const text = decodeText(source.slice(cursor, open)).trim()
        if (text !== '') {
          ;(parent as { text: string }).text = parent.text === '' ? text : `${parent.text}${text}`
        }
      }
    }

    if (source.startsWith('<!--', open)) {
      const end = source.indexOf('-->', open)
      if (end === -1) return { ok: false, reason: 'This manifest ends inside a comment.' }
      cursor = end + 3
      continue
    }
    if (source.startsWith('<![CDATA[', open)) {
      const end = source.indexOf(']]>', open)
      if (end === -1) return { ok: false, reason: 'This manifest ends inside a CDATA section.' }
      const parent = stack[stack.length - 1]
      if (parent && parent !== root) {
        ;(parent as { text: string }).text += source.slice(open + 9, end)
      }
      cursor = end + 3
      continue
    }
    if (source.startsWith('<?', open)) {
      const end = source.indexOf('?>', open)
      if (end === -1) return { ok: false, reason: 'This manifest ends inside a declaration.' }
      cursor = end + 2
      continue
    }

    const close = source.indexOf('>', open)
    if (close === -1) return { ok: false, reason: 'This manifest ends inside a tag.' }
    const inner = source.slice(open + 1, close)

    if (inner.startsWith('/')) {
      // A closing tag. Mismatches are tolerated by popping one level: a
      // manifest that is slightly malformed is common, and refusing the whole
      // download over it helps nobody.
      if (stack.length > 1) stack.pop()
      cursor = close + 1
      continue
    }

    const selfClosing = inner.endsWith('/')
    const body = selfClosing ? inner.slice(0, -1) : inner
    const nameMatch = /^\s*([A-Za-z_:][-\w:.]*)/.exec(body)
    if (!nameMatch?.[1]) {
      cursor = close + 1
      continue
    }

    nodes += 1
    if (nodes > XML_LIMITS.maxNodes) {
      return { ok: false, reason: 'This manifest describes too many elements to read safely.' }
    }

    const node: XmlNode = {
      name: localName(nameMatch[1]),
      attributes: parseAttributes(body.slice(nameMatch[0].length)),
      children: [],
      text: ''
    }
    stack[stack.length - 1]?.children.push(node)

    if (!selfClosing) {
      if (stack.length >= XML_LIMITS.maxDepth) {
        return { ok: false, reason: 'This manifest is nested too deeply to read safely.' }
      }
      stack.push(node)
    }
    cursor = close + 1
  }

  const first = root.children[0]
  return first ? { ok: true, root: first } : { ok: false, reason: 'This manifest has no content.' }
}

/** Direct children with this name. */
export function childrenNamed(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((child) => child.name === name)
}

/** The first direct child with this name, or null. */
export function childNamed(node: XmlNode, name: string): XmlNode | null {
  return node.children.find((child) => child.name === name) ?? null
}
