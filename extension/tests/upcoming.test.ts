import { describe, expect, it } from 'vitest'
import {
  badgeState,
  buildUpcoming,
  filterVisible,
  relativeTime,
  urgencyOf,
  type CachedAssignment,
} from '../src/lib/upcoming'

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
    const b = badgeState([a({ dueIso: iso('2026-09-20T16:00:00') })], { now: NOW2 })
    expect(b.text).toBe('')
    expect(b.title).toBe('Nothing due soon')
  })

  it('counts work due within the window in amber', () => {
    const b = badgeState(
      [
        a({ dueIso: iso('2026-09-03T16:00:00'), key: 'x' }),
        a({ dueIso: iso('2026-09-02T18:00:00'), key: 'y' }),
      ],
      { now: NOW2 },
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
      { now: NOW2 },
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
      { now: NOW2 },
    )
    expect(b.text).toBe('')
  })

  it('ignores work beyond the window', () => {
    expect(badgeState([a({ dueIso: iso('2026-09-10T16:00:00') })], { now: NOW2 }).text).toBe('')
  })

  it('singularises the tooltip', () => {
    expect(badgeState([a({ dueIso: iso('2026-08-30T16:00:00') })], { now: NOW2 }).title).toBe(
      '1 overdue assignment',
    )
  })

  it('caps a very large count', () => {
    const many = Array.from({ length: 120 }, (_, i) =>
      a({ dueIso: iso('2026-08-30T16:00:00'), key: `k${i}` }),
    )
    expect(badgeState(many, { now: NOW2 }).text).toBe('99+')
  })
})

describe('relativeTime', () => {
  const n = new Date('2026-09-02T12:00:00')

  it('formats minutes, hours and days ahead', () => {
    expect(relativeTime(new Date('2026-09-02T12:25:00'), n)).toBe('in 25m')
    expect(relativeTime(new Date('2026-09-02T16:00:00'), n)).toBe('in 4h')
    expect(relativeTime(new Date('2026-09-05T12:00:00'), n)).toBe('in 3d')
  })

  it('formats the past', () => {
    expect(relativeTime(new Date('2026-08-31T12:00:00'), n)).toBe('2d ago')
    expect(relativeTime(new Date('2026-09-02T11:30:00'), n)).toBe('30m ago')
  })

  it('collapses the current minute to "now"', () => {
    expect(relativeTime(new Date('2026-09-02T12:00:30'), n)).toBe('now')
  })

  it('rounds down rather than up', () => {
    expect(relativeTime(new Date('2026-09-02T13:59:00'), n)).toBe('in 1h')
  })
})

describe('urgencyOf', () => {
  const n = new Date('2026-09-02T12:00:00')

  it('bands by time remaining', () => {
    expect(urgencyOf(new Date('2026-09-02T11:00:00'), n)).toBe('overdue')
    expect(urgencyOf(new Date('2026-09-02T15:00:00'), n)).toBe('soon')
    expect(urgencyOf(new Date('2026-09-03T10:00:00'), n)).toBe('today')
    expect(urgencyOf(new Date('2026-09-10T10:00:00'), n)).toBe('later')
  })
})

describe('hiding overdue work', () => {
  const NOW3 = new Date('2026-09-02T12:00:00')
  const old = a({ dueIso: iso('2026-08-20T16:00:00'), key: 'old', title: 'Ancient' })
  const recent = a({ dueIso: iso('2026-09-01T16:00:00'), key: 'recent', title: 'Yesterday' })

  const titles = (v: ReturnType<typeof buildUpcoming>) =>
    v.groups.flatMap((g) => g.items.map((i) => i.title))

  it('keeps all overdue work when no grace period is set', () => {
    const v = buildUpcoming([old, recent], { now: NOW3 })
    expect(titles(v)).toEqual(['Ancient', 'Yesterday'])
  })

  // Work you can no longer submit should not sit in the list forever.
  it('ages out overdue work past the grace period', () => {
    const v = buildUpcoming([old, recent], { now: NOW3, hideOverdueAfterDays: 3 })
    expect(titles(v)).toEqual(['Yesterday'])
  })

  it('never ages out work that is not yet due', () => {
    const future = a({ dueIso: iso('2026-09-20T16:00:00'), key: 'f', title: 'Future' })
    const v = buildUpcoming([future], { now: NOW3, hideOverdueAfterDays: 1, days: 30 })
    expect(titles(v)).toEqual(['Future'])
  })

  it('stops the badge counting aged-out work', () => {
    expect(badgeState([old], { now: NOW3 }).text).toBe('1')
    expect(badgeState([old], { now: NOW3, hideOverdueAfterDays: 3 }).text).toBe('')
  })
})

describe('dismissing assignments', () => {
  const NOW3 = new Date('2026-09-02T12:00:00')
  const one = a({ dueIso: iso('2026-08-25T16:00:00'), key: 'k1', title: 'Dead' })
  // Inside the 48h badge window, so it should still register.
  const two = a({ dueIso: iso('2026-09-03T16:00:00'), key: 'k2', title: 'Live' })

  it('removes a dismissed item from the list', () => {
    const v = buildUpcoming([one, two], { now: NOW3, dismissed: ['k1'] })
    expect(v.groups.flatMap((g) => g.items.map((i) => i.title))).toEqual(['Live'])
  })

  // Dismissing pointless overdue work has to clear the red badge too, or
  // dismissing it achieves nothing.
  it('removes a dismissed item from the badge count', () => {
    expect(badgeState([one], { now: NOW3 }).text).toBe('1')
    expect(badgeState([one], { now: NOW3, dismissed: ['k1'] }).text).toBe('')
  })

  it('leaves other assignments alone', () => {
    expect(badgeState([one, two], { now: NOW3, dismissed: ['k1'] }).text).toBe('1')
  })

  it('ignores dismissals for assignments that no longer exist', () => {
    const v = buildUpcoming([two], { now: NOW3, dismissed: ['gone', 'k1'] })
    expect(v.groups.flatMap((g) => g.items.map((i) => i.title))).toEqual(['Live'])
  })
})

describe('filterVisible', () => {
  const NOW3 = new Date('2026-09-02T12:00:00')

  it('drops submitted work that is already past due', () => {
    const done = a({ dueIso: iso('2026-08-30T16:00:00'), key: 'd', submitted: true })
    expect(filterVisible([done], { now: NOW3 })).toEqual([])
  })

  it('keeps submitted work that is still upcoming', () => {
    const soon = a({ dueIso: iso('2026-09-05T16:00:00'), key: 's', submitted: true })
    expect(filterVisible([soon], { now: NOW3 })).toHaveLength(1)
  })

  it('drops unparseable dates', () => {
    expect(filterVisible([a({ dueIso: 'nope' })], { now: NOW3 })).toEqual([])
  })
})

describe('collapsing the overdue group', () => {
  const NOW4 = new Date('2026-09-02T12:00:00')
  const items = [
    a({ dueIso: iso('2026-08-30T16:00:00'), key: 'late', title: 'Missed' }),
    a({ dueIso: iso('2026-09-04T16:00:00'), key: 'next', title: 'Upcoming' }),
  ]
  const titles = (v: ReturnType<typeof buildUpcoming>) =>
    v.groups.flatMap((g) => g.items.map((i) => i.title))

  it('removes the overdue group from the list', () => {
    expect(titles(buildUpcoming(items, { now: NOW4, hideOverdue: true }))).toEqual(['Upcoming'])
    expect(titles(buildUpcoming(items, { now: NOW4 }))).toEqual(['Missed', 'Upcoming'])
  })

  // Collapsing is visual only, so the work still exists and still counts.
  it('still reports how many are overdue', () => {
    expect(buildUpcoming(items, { now: NOW4, hideOverdue: true }).overdueCount).toBe(1)
  })

  it('leaves the badge untouched, unlike dismissing', () => {
    expect(badgeState(items, { now: NOW4 }).text).toBe('1')
    expect(badgeState(items, { now: NOW4 }).color).toBe('#cf222e')
  })

  it('does not miscount the overflow when collapsed', () => {
    const many = [
      ...Array.from({ length: 3 }, (_, i) =>
        a({ dueIso: iso('2026-08-2' + (i + 1) + 'T16:00:00'), key: `o${i}`, title: `Old${i}` }),
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        a({ dueIso: iso('2026-09-0' + (i + 3) + 'T16:00:00'), key: `n${i}`, title: `New${i}` }),
      ),
    ]
    const v = buildUpcoming(many, { now: NOW4, hideOverdue: true, max: 2 })
    expect(v.groups.flatMap((g) => g.items)).toHaveLength(2)
    expect(v.hiddenCount).toBe(1)
  })
})
