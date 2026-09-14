import { describe, it, expect, beforeEach } from 'vitest'
import { ClosedTabRepository, CLOSED_TAB_LIMIT, type ClosedTabRecord } from './ClosedTabRepository'

/**
 * A stand-in for the SQLite connection.
 *
 * The repository is the piece worth testing — ordering, the limit, and that
 * reopen consumes rather than copies. Wiring it to a real database here would
 * test better-sqlite3, which is not ours to verify.
 */
function fakeDb() {
  const rows: (ClosedTabRecord & { id: number })[] = []
  let nextId = 1

  return {
    rows,
    connection: {
      prepare(sql: string) {
        return {
          all(limit?: number) {
            if (sql.includes('SELECT')) {
              const sorted = [...rows].sort((a, b) => b.closedAt - a.closedAt || b.id - a.id)
              return sorted.slice(0, limit ?? sorted.length).map(toRow)
            }
            return []
          },
          get(id?: number) {
            // The keyed read and the newest-first read are different queries,
            // and a stand-in that answered both the same way would pass a take()
            // that ignored its argument entirely.
            if (sql.includes('WHERE id = ?')) {
              const found = rows.find((r) => r.id === id)
              return found ? toRow(found) : undefined
            }
            const sorted = [...rows].sort((a, b) => b.closedAt - a.closedAt || b.id - a.id)
            const first = sorted[0]
            return first ? toRow(first) : undefined
          },
          run(...args: unknown[]) {
            if (sql.startsWith('INSERT')) {
              rows.push({
                id: nextId++,
                url: args[0] as string,
                title: args[1] as string,
                faviconUrl: args[2] as string | null,
                index: args[3] as number,
                isPinned: args[4] === 1,
                workspaceId: args[5] as string,
                navigation: args[6] as string,
                closedAt: args[7] as number
              })
            } else if (sql.includes('DELETE FROM closed_tabs WHERE id = ?')) {
              const at = rows.findIndex((r) => r.id === args[0])
              if (at !== -1) rows.splice(at, 1)
            } else if (sql.includes('NOT IN')) {
              const keep = [...rows]
                .sort((a, b) => b.closedAt - a.closedAt || b.id - a.id)
                .slice(0, args[0] as number)
              rows.length = 0
              rows.push(...keep)
            } else if (sql.startsWith('DELETE FROM closed_tabs')) {
              rows.length = 0
            }
            return { changes: 1 }
          }
        }
      }
    }
  }
}

function toRow(r: ClosedTabRecord & { id: number }) {
  return {
    id: r.id,
    url: r.url,
    title: r.title,
    favicon_url: r.faviconUrl,
    tab_index: r.index,
    is_pinned: r.isPinned ? 1 : 0,
    workspace_id: r.workspaceId,
    navigation: r.navigation,
    closed_at: r.closedAt
  }
}

const record = (over: Partial<ClosedTabRecord> = {}): ClosedTabRecord => ({
  url: 'https://example.com/',
  title: 'Example',
  faviconUrl: null,
  index: 0,
  isPinned: false,
  workspaceId: 'default',
  navigation: '',
  closedAt: 1000,
  ...over
})

describe('ClosedTabRepository', () => {
  let db: ReturnType<typeof fakeDb>
  let repo: ClosedTabRepository

  beforeEach(() => {
    db = fakeDb()
    repo = new ClosedTabRepository(db as never)
  })

  it('returns the most recently closed tab first', () => {
    repo.add(record({ url: 'https://first.example/', closedAt: 1000 }))
    repo.add(record({ url: 'https://second.example/', closedAt: 2000 }))

    expect(repo.takeLatest()?.url).toBe('https://second.example/')
  })

  it('consumes the entry, so reopening twice does not open it twice', () => {
    repo.add(record({ url: 'https://only.example/' }))

    expect(repo.takeLatest()?.url).toBe('https://only.example/')
    expect(repo.takeLatest()).toBeNull()
  })

  it('keeps back/forward history alongside the address', () => {
    // A reopened tab with a dead Back button is only half the tab you lost.
    const navigation = JSON.stringify({ entries: [{ url: 'https://a/' }], activeIndex: 0 })
    repo.add(record({ navigation }))
    expect(repo.takeLatest()?.navigation).toBe(navigation)
  })

  it('round-trips pinning and workspace', () => {
    repo.add(record({ isPinned: true, workspaceId: 'ws-work', index: 3 }))
    const back = repo.takeLatest()
    expect(back?.isPinned).toBe(true)
    expect(back?.workspaceId).toBe('ws-work')
    expect(back?.index).toBe(3)
  })

  it('caps the list so it cannot become a second history', () => {
    for (let i = 0; i < CLOSED_TAB_LIMIT + 10; i += 1) {
      repo.add(record({ url: `https://n${i}.example/`, closedAt: 1000 + i }))
    }
    expect(db.rows.length).toBe(CLOSED_TAB_LIMIT)
    // The oldest are the ones dropped.
    expect(repo.takeLatest()?.url).toBe(`https://n${CLOSED_TAB_LIMIT + 9}.example/`)
  })

  it('lists oldest first, matching the stack order reopen pops from', () => {
    repo.add(record({ url: 'https://old.example/', closedAt: 1000 }))
    repo.add(record({ url: 'https://new.example/', closedAt: 2000 }))

    const list = repo.list()
    expect(list[0]?.url).toBe('https://old.example/')
    expect(list[list.length - 1]?.url).toBe('https://new.example/')
  })

  it('returns null when nothing has been closed', () => {
    expect(repo.takeLatest()).toBeNull()
    expect(repo.list()).toEqual([])
  })

  it('clears everything', () => {
    repo.add(record())
    repo.clear()
    expect(repo.list()).toEqual([])
  })

  it('takes one particular entry, leaving the rest', () => {
    repo.add(record({ url: 'https://first.example/', closedAt: 1000 }))
    repo.add(record({ url: 'https://second.example/', closedAt: 2000 }))
    repo.add(record({ url: 'https://third.example/', closedAt: 3000 }))

    const wanted = repo.list().find((entry) => entry.url === 'https://second.example/')!
    expect(repo.take(wanted.id)?.url).toBe('https://second.example/')
    expect(repo.list().map((entry) => entry.url)).toEqual([
      'https://first.example/',
      'https://third.example/'
    ])
  })

  it('consumes the entry it takes', () => {
    repo.add(record({ url: 'https://only.example/' }))
    const id = repo.list()[0]!.id
    expect(repo.take(id)).not.toBeNull()
    expect(repo.take(id)).toBeNull()
  })

  it('returns null for an id that is no longer there', () => {
    // An ordinary outcome, not an error: a caller's list can be a moment out of
    // date, and the entry may already have been reopened, pruned or cleared.
    expect(repo.take(999)).toBeNull()
  })

  it('names entries by row id, not by when they closed', () => {
    // Closing a window shuts every tab in the same millisecond, so a timestamp
    // is not a name for one of them.
    repo.add(record({ url: 'https://a.example/', closedAt: 5000 }))
    repo.add(record({ url: 'https://b.example/', closedAt: 5000 }))

    const ids = repo.list().map((entry) => entry.id)
    expect(new Set(ids).size).toBe(2)
    repo.take(ids[0]!)
    expect(repo.list()).toHaveLength(1)
  })
})
