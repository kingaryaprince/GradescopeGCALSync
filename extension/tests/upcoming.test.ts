import { describe, expect, it } from 'vitest'
import { badgeState, buildUpcoming, type CachedAssignment } from '../src/lib/upcoming'

const NOW = new Date('2026-09-02T12:00:00')
const iso = (s: string) => new Date(s).toISOString()

const a = (over: Partial<CachedAssignment> & { dueIso: string }): CachedAssignment => ({
  key: `k${over.dueIso}`,
  title: 'Homework 5',
  courseId: '100',
  courseShortName: 'CS 70',
  submitted: false,
  ...over,
})

describe('buildUpcoming', () => {
  it('labels today, tomorrow, and a weekday', () => {
    const v = buildUpcoming(
      [
        a({ dueIso: iso('2026-09-02T16:00:00'), title: 'Now' }),
        a({ dueIso: iso('2026-09-03T16:00:00'), title: 'Next' }),
        a({ dueIso: iso('2026-09-05T16:00:00'), title: 'Later' }),
      ],
      { now: NOW },
    )
    expect(v.groups.map((g) => g.label)).toEqual(['Today', 'Tomorrow', 'Saturday'])
  })

  it('keeps items in chronological order', () => {
    const v = buildUpcoming(
      [
        a({ dueIso: iso('2026-09-06T16:00:00'), title: 'Third' }),
        a({ dueIso: iso('2026-09-02T16:00:00'), title: 'First' }),
        a({ dueIso: iso('2026-09-04T16:00:00'), title: 'Second' }),
      ],
      { now: NOW },
    )
    expect(v.groups.flatMap((g) => g.items.map((i) => i.title))).toEqual(['First', 'Second', 'Third'])
  })

  it('collects unsubmitted past-due work under Overdue, first', () => {
    const v = buildUpcoming(
      [
        a({ dueIso: iso('2026-09-04T16:00:00'), title: 'Future' }),
        a({ dueIso: iso('2026-08-30T16:00:00'), title: 'Missed' }),
      ],
      { now: NOW },
    )
    expect(v.groups[0]!.label).toBe('Overdue')
    expect(v.groups[0]!.items[0]!.title).toBe('Missed')
    expect(v.overdueCount).toBe(1)
  })

  // Past-due work you already submitted is just done.
  it('drops submitted work that is past due', () => {
    const v = buildUpcoming(
      [a({ dueIso: iso('2026-08-30T16:00:00'), title: 'Done', submitted: true })],
      { now: NOW },
    )
    expect(v.groups).toEqual([])
    expect(v.overdueCount).toBe(0)
  })

  it('keeps submitted work that is still upcoming, flagged', () => {
    const v = buildUpcoming(
      [a({ dueIso: iso('2026-09-04T16:00:00'), submitted: true })],
      { now: NOW },
    )
    expect(v.groups[0]!.items[0]!.submitted).toBe(true)
  })

  it('can hide submitted work entirely', () => {
    const items = [
      a({ dueIso: iso('2026-09-04T16:00:00'), title: 'Done', submitted: true }),
      a({ dueIso: iso('2026-09-05T16:00:00'), title: 'Todo' }),
    ]
    const v = buildUpcoming(items, { now: NOW, hideSubmitted: true })
    expect(v.groups.flatMap((g) => g.items.map((i) => i.title))).toEqual(['Todo'])
  })

  it('respects the lookahead window', () => {
    const v = buildUpcoming(
      [
        a({ dueIso: iso('2026-09-05T16:00:00'), title: 'In' }),
        a({ dueIso: iso('2026-10-20T16:00:00'), title: 'Out' }),
      ],
      { now: NOW, days: 14 },
    )
    expect(v.groups.flatMap((g) => g.items.map((i) => i.title))).toEqual(['In'])
  })

  it('caps rows and reports the remainder', () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      a({ dueIso: iso(`2026-09-0${(i % 7) + 3}T16:00:00`), key: `k${i}`, title: `A${i}` }),
    )
    const v = buildUpcoming(many, { now: NOW, max: 4 })
    expect(v.groups.flatMap((g) => g.items)).toHaveLength(4)
    expect(v.hiddenCount).toBe(5)
  })

  it('merges same-day items into one group', () => {
    const v = buildUpcoming(
      [
        a({ dueIso: iso('2026-09-04T10:00:00'), key: 'x', title: 'A' }),
        a({ dueIso: iso('2026-09-04T18:00:00'), key: 'y', title: 'B' }),
      ],
      { now: NOW },
    )
    expect(v.groups).toHaveLength(1)
    expect(v.groups[0]!.items).toHaveLength(2)
  })

  it('ignores unparseable dates and an empty cache', () => {
    expect(buildUpcoming([a({ dueIso: 'not a date' })], { now: NOW }).groups).toEqual([])
    expect(buildUpcoming([], { now: NOW })).toEqual({ groups: [], hiddenCount: 0, overdueCount: 0 })
  })
})

describe('badgeState', () => {
  const NOW2 = new Date('2026-09-02T12:00:00')

  it('is empty when nothing is outstanding', () => {
    const b = badgeState([a({ dueIso: iso('2026-09-20T16:00:00') })], NOW2)
    expect(b.text).toBe('')
    expect(b.title).toBe('Nothing due soon')
  })

  it('counts work due within the window in amber', () => {
    const b = badgeState(
      [
        a({ dueIso: iso('2026-09-03T16:00:00'), key: 'x' }),
        a({ dueIso: iso('2026-09-02T18:00:00'), key: 'y' }),
      ],
      NOW2,
    )
    expect(b.text).toBe('2')
    expect(b.color).toBe('#bf8700')
  })

  // A missed deadline is the more urgent signal.
  it('lets overdue take priority over due-soon', () => {
    const b = badgeState(
      [
        a({ dueIso: iso('2026-08-30T16:00:00'), key: 'late' }),
        a({ dueIso: iso('2026-09-03T16:00:00'), key: 'soon' }),
      ],
      NOW2,
    )
    expect(b.text).toBe('1')
    expect(b.color).toBe('#cf222e')
    expect(b.title).toContain('overdue')
  })

  it('never counts submitted work', () => {
    const b = badgeState(
      [
        a({ dueIso: iso('2026-08-30T16:00:00'), key: 'a', submitted: true }),
        a({ dueIso: iso('2026-09-03T16:00:00'), key: 'b', submitted: true }),
      ],
      NOW2,
    )
    expect(b.text).toBe('')
  })

  it('ignores work beyond the window', () => {
    expect(badgeState([a({ dueIso: iso('2026-09-10T16:00:00') })], NOW2).text).toBe('')
  })

  it('singularises the tooltip', () => {
    expect(badgeState([a({ dueIso: iso('2026-08-30T16:00:00') })], NOW2).title).toBe(
      '1 overdue assignment',
    )
  })

  it('caps a very large count', () => {
    const many = Array.from({ length: 120 }, (_, i) =>
      a({ dueIso: iso('2026-08-30T16:00:00'), key: `k${i}` }),
    )
    expect(badgeState(many, NOW2).text).toBe('99+')
  })
})
