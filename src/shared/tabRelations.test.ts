import { describe, it, expect } from 'vitest'
import {
  buildRelations,
  siteOf,
  firstSegment,
  countTabs,
  type RelatedTab,
  type RelationBranch,
  type RelationNode
} from './tabRelations'

let n = 0
const tab = (url: string, title = 'A page'): RelatedTab => ({
  id: `t${(n += 1)}`,
  url,
  title,
  workspaceId: 'default'
})

const labels = (branches: readonly RelationBranch[]): string[] =>
  branches.map((branch) => branch.label)

describe('siteOf', () => {
  it('drops www', () => {
    expect(siteOf('https://www.example.com/a')).toBe('example.com')
  })

  it('groups a subdomain with its site', () => {
    // Somebody with docs.example.com and example.com open is looking at one
    // thing, and two branches would hide that.
    expect(siteOf('https://docs.example.com/a')).toBe('example.com')
  })

  it('does not truncate a two-label suffix to nonsense', () => {
    // Without the suffix list this returned "co.uk", collapsing every unrelated
    // British site in the window into one branch. Caught by this test.
    expect(siteOf('https://example.co.uk/a')).toBe('example.co.uk')
    expect(siteOf('https://shop.example.co.uk/a')).toBe('example.co.uk')
    expect(siteOf('https://example.com.au/a')).toBe('example.com.au')
  })

  it('keeps two unrelated sites on the same suffix apart', () => {
    expect(siteOf('https://alpha.co.uk/')).not.toBe(siteOf('https://beta.co.uk/'))
  })

  it('drops deeper subdomains too', () => {
    expect(siteOf('https://a.b.c.example.com/x')).toBe('example.com')
  })

  it('ignores anything that is not the web', () => {
    expect(siteOf('slash://newtab')).toBeNull()
    expect(siteOf('file:///c:/x.html')).toBeNull()
    expect(siteOf('not a url')).toBeNull()
  })
})

describe('firstSegment', () => {
  it('reads a section', () => {
    expect(firstSegment('https://x.test/docs/getting-started')).toBe('docs')
  })

  it('is empty at the root', () => {
    expect(firstSegment('https://x.test/')).toBe('')
  })

  it('refuses a slug', () => {
    // `/how-to-do-the-thing-in-2026` as a heading is the article's own title,
    // spelled badly.
    expect(firstSegment('https://x.test/how-to-do-the-thing-in-2026')).toBe('')
  })
})

describe('buildRelations', () => {
  it('returns nothing for no tabs', () => {
    expect(buildRelations([])).toEqual([])
  })

  it('ignores internal pages', () => {
    expect(buildRelations([tab('slash://newtab')])).toEqual([])
  })

  it('groups tabs by site', () => {
    const branches = buildRelations([
      tab('https://a.test/1'),
      tab('https://a.test/2'),
      tab('https://b.test/1')
    ])
    expect(labels(branches)).toEqual(['a.test', 'b.test'])
    expect(branches[0]?.count).toBe(2)
  })

  it('puts the busiest site first', () => {
    // The reason to open this view is usually "where did that tab go", and the
    // site with most tabs is where it went.
    const branches = buildRelations([
      tab('https://small.test/1'),
      tab('https://big.test/1'),
      tab('https://big.test/2'),
      tab('https://big.test/3')
    ])
    expect(labels(branches)).toEqual(['big.test', 'small.test'])
  })

  it('does not make sections out of a handful of tabs', () => {
    // Three tabs under one host is a list, not a tree.
    const branches = buildRelations([
      tab('https://a.test/docs/1'),
      tab('https://a.test/docs/2'),
      tab('https://a.test/blog/1')
    ])
    expect(branches[0]?.children.every((child) => child.kind === 'tab')).toBe(true)
  })

  it('makes sections once a site has enough tabs to need them', () => {
    const branches = buildRelations([
      tab('https://a.test/docs/1'),
      tab('https://a.test/docs/2'),
      tab('https://a.test/docs/3'),
      tab('https://a.test/blog/1'),
      tab('https://a.test/blog/2')
    ])
    const sections = branches[0]?.children.filter((child) => child.kind === 'branch') ?? []
    expect(sections.map((s) => (s.kind === 'branch' ? s.label : ''))).toEqual(['docs', 'blog'])
  })

  it('leaves a lone tab flat rather than giving it a heading', () => {
    // A section of one is one tab with extra indentation.
    const branches = buildRelations([
      tab('https://a.test/docs/1'),
      tab('https://a.test/docs/2'),
      tab('https://a.test/docs/3'),
      tab('https://a.test/alone/1'),
      tab('https://a.test/')
    ])
    const children = branches[0]?.children ?? []
    const sections = children.filter((c) => c.kind === 'branch')
    expect(sections).toHaveLength(1)
    // The lone tab and the root tab are still present, just not under headings.
    expect(children.filter((c) => c.kind === 'tab')).toHaveLength(2)
  })

  it('does not make one section that holds everything', () => {
    // Twelve Wikipedia tabs all sit under /wiki, and the tree drew
    // "wikipedia.org → wiki → (twelve tabs)" — indentation separating nothing
    // from nothing.
    const branches = buildRelations(
      Array.from({ length: 6 }, (_, i) => tab(`https://a.test/wiki/page-${i}`))
    )
    expect(branches[0]?.children.every((child) => child.kind === 'tab')).toBe(true)
  })

  it('loses no tab, whatever the shape', () => {
    // The one invariant that matters: this is a way of finding a tab, so a tab
    // the tree forgot is the whole feature failing quietly.
    const tabs = [
      tab('https://a.test/docs/1'),
      tab('https://a.test/docs/2'),
      tab('https://a.test/docs/3'),
      tab('https://a.test/alone/1'),
      tab('https://a.test/'),
      tab('https://b.test/x'),
      tab('https://docs.b.test/y')
    ]
    const branches = buildRelations(tabs)
    const seen = new Set<string>()
    const walk = (nodes: readonly RelationNode[]): void => {
      for (const node of nodes) {
        if (node.kind === 'tab') seen.add(node.tab.id)
        else walk(node.children)
      }
    }
    walk(branches)
    expect(seen.size).toBe(tabs.length)
    expect(countTabs(branches)).toBe(tabs.length)
  })

  it('gives every branch a distinct key', () => {
    // Two sites can both have a `docs` section, and React would reuse one
    // branch's state for the other's.
    const branches = buildRelations([
      ...Array.from({ length: 4 }, () => tab('https://a.test/docs/x')),
      ...Array.from({ length: 4 }, () => tab('https://b.test/docs/x'))
    ])
    const keys: string[] = []
    for (const branch of branches) {
      keys.push(branch.key)
      for (const child of branch.children) {
        if (child.kind === 'branch') keys.push(child.key)
      }
    }
    expect(new Set(keys).size).toBe(keys.length)
  })
})
