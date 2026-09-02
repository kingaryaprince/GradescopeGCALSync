import { describe, expect, it } from 'vitest'
import { groupCoursesByTerm } from '../src/lib/terms'
import type { Course } from '../src/lib/types'

const c = (shortName: string, term?: string, id = shortName): Course => ({
  id,
  shortName,
  name: shortName,
  ...(term ? { term } : {}),
  url: `https://www.gradescope.com/courses/${id}`,
})

// Mirrors the user's real dashboard.
const REAL = [
  c('Data 140 Fall 2026', 'Fall 2026'),
  c('Chem 1A Summer 2026', 'Summer 2026'),
  c('CDSS 170', 'Spring 2026'),
  c('CS 170', 'Spring 2026'),
  c('CS 189/289A', 'Spring 2026'),
]
const NOW = new Date('2026-09-01T12:00:00')

describe('groupCoursesByTerm', () => {
  it('orders terms newest first', () => {
    expect(groupCoursesByTerm(REAL, NOW).map((g) => g.term)).toEqual([
      'Fall 2026', 'Summer 2026', 'Spring 2026',
    ])
  })

  // Gradescope shows Fall 2026 and Summer 2026, hiding Spring 2026 and older.
  it('matches Gradescope: current and overlapping terms stay expanded', () => {
    const g = groupCoursesByTerm(REAL, NOW)
    expect(g.filter((x) => x.isRecent).map((x) => x.term)).toEqual(['Fall 2026', 'Summer 2026'])
  })

  it('groups every course under its term', () => {
    const spring = groupCoursesByTerm(REAL, NOW).find((g) => g.term === 'Spring 2026')!
    expect(spring.courses.map((x) => x.shortName)).toEqual(['CDSS 170', 'CS 170', 'CS 189/289A'])
  })

  it('sorts courses alphabetically inside a term', () => {
    const shuffled = [c('CS 170', 'Spring 2026'), c('CDSS 170', 'Spring 2026')]
    expect(groupCoursesByTerm(shuffled, NOW)[0]!.courses.map((x) => x.shortName)).toEqual([
      'CDSS 170', 'CS 170',
    ])
  })

  it('puts courses with no term last and collapsed', () => {
    const g = groupCoursesByTerm([...REAL, c('Legacy', undefined)], NOW)
    expect(g[g.length - 1]!.term).toBe('Other')
    expect(g[g.length - 1]!.isRecent).toBe(false)
  })

  it('keeps a group open even when every term is in the past', () => {
    const g = groupCoursesByTerm([c('CS 61B', 'Spring 2020')], NOW)
    expect(g[0]!.isRecent).toBe(true)
  })

  it('treats a future term as recent', () => {
    const g = groupCoursesByTerm([c('CS 999', 'Spring 2027'), c('CS 170', 'Spring 2026')], NOW)
    expect(g[0]!.term).toBe('Spring 2027')
    expect(g[0]!.isRecent).toBe(true)
  })

  it('handles an empty list', () => {
    expect(groupCoursesByTerm([], NOW)).toEqual([])
  })
})
