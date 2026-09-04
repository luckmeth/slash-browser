import { describe, it, expect } from 'vitest'
import { ON_MISSION_THRESHOLD, scoreRelevance, suggestionFor } from './missionRelevance'

const page = (title: string, url = 'https://example.com/page') => ({ title, url })

describe('scoreRelevance', () => {
  const goal = 'Finish my research paper on coral reef bleaching'

  it('recognises a page that matches the goal', () => {
    const verdict = scoreRelevance(page('Coral bleaching in the Great Barrier Reef'), goal, [])
    expect(verdict.onMission).toBe(true)
    expect(verdict.shared.length).toBeGreaterThan(0)
  })

  it('recognises a digression', () => {
    const verdict = scoreRelevance(page('Premier League results and table'), goal, [])
    expect(verdict.onMission).toBe(false)
  })

  it('uses the mission’s existing pages, not only its goal', () => {
    // "Shinkansen timetable" shares nothing with "plan my trip", but a mission
    // already holding Japanese rail pages plainly covers it.
    const tripGoal = 'Plan my trip'
    const alone = scoreRelevance(page('Shinkansen timetable and seat reservations'), tripGoal, [])
    const withContext = scoreRelevance(page('Shinkansen timetable and seat reservations'), tripGoal, [
      page('Shinkansen rail pass prices'),
      page('Tokyo to Kyoto Shinkansen guide')
    ])
    expect(alone.onMission).toBe(false)
    expect(withContext.onMission).toBe(true)
    expect(withContext.score).toBeGreaterThan(alone.score)
  })

  it('stays silent on a page it cannot judge', () => {
    // No title and no meaningful path. A verdict here would be a coin toss.
    const verdict = scoreRelevance({ title: '', url: 'https://example.com/' }, goal, [])
    expect(verdict.onMission).toBe(true)
  })

  it('is biased towards not interrupting', () => {
    // A false "off-mission" on a page the user needs is worse than silence on a
    // real distraction — they already know they are distracted.
    expect(ON_MISSION_THRESHOLD).toBeLessThan(0.2)
  })

  it('does not treat "same website" as "same goal"', () => {
    // Caught by a probe: a football page joined a coral-reef mission because both
    // were on Wikipedia and the shared site name outweighed the titles.
    const missionPages = [
      { url: 'https://en.wikipedia.org/wiki/Coral_bleaching', title: 'Coral bleaching - Wikipedia' },
      { url: 'https://en.wikipedia.org/wiki/Coral_reef', title: 'Coral reef - Wikipedia' }
    ]
    const verdict = scoreRelevance(
      { url: 'https://en.wikipedia.org/wiki/Premier_League', title: 'Premier League - Wikipedia' },
      goal,
      missionPages
    )
    expect(verdict.onMission).toBe(false)
  })

  it('reports the terms behind its verdict', () => {
    const verdict = scoreRelevance(page('Coral reef bleaching data'), goal, [])
    expect(verdict.shared.some((term) => ['coral', 'reef', 'bleaching'].includes(term))).toBe(true)
  })
})

describe('suggestionFor', () => {
  it('says nothing when the page is on-mission', () => {
    expect(suggestionFor({ onMission: true, score: 0.5, shared: [] }, 'Write my paper')).toBeNull()
  })

  it('offers rather than warns', () => {
    // This is the user's browser; they are allowed to open whatever they like.
    const suggestion = suggestionFor({ onMission: false, score: 0, shared: [] }, 'Write my paper')!
    expect(suggestion).toContain('save it for later?')
    expect(suggestion.toLowerCase()).not.toContain('blocked')
    expect(suggestion.toLowerCase()).not.toContain('not allowed')
  })

  it('names the mission, so the prompt is not mysterious', () => {
    expect(suggestionFor({ onMission: false, score: 0, shared: [] }, 'Write my paper')).toContain(
      'Write my paper'
    )
  })
})
