import { describe, expect, it } from 'vitest'
import { parseDueDate, termWindow, looksLikeDueDate } from '../src/lib/gradescope/dates'

const at = (s: string) => new Date(s)

describe('parseDueDate', () => {
  it('parses the standard Gradescope format', () => {
    const d = parseDueDate('Oct 04 at 4:00PM', { now: at('2025-09-15T12:00:00') })!
    expect(d.getFullYear()).toBe(2025)
    expect(d.getMonth()).toBe(9)
    expect(d.getDate()).toBe(4)
    expect(d.getHours()).toBe(16)
    expect(d.getMinutes()).toBe(0)
  })

  it('handles midnight and noon in 12-hour time', () => {
    expect(parseDueDate('Nov 03 at 12:00AM', { now: at('2025-11-01T00:00:00') })!.getHours()).toBe(0)
    expect(parseDueDate('Nov 03 at 12:00PM', { now: at('2025-11-01T00:00:00') })!.getHours()).toBe(12)
    expect(parseDueDate('Nov 03 at 11:59PM', { now: at('2025-11-01T00:00:00') })!.getHours()).toBe(23)
  })

  // This is the bug that made the original script wrong every winter.
  it('rolls the year forward for a spring deadline read in December', () => {
    const d = parseDueDate('Jan 15 at 11:59PM', { now: at('2025-12-20T09:00:00') })!
    expect(d.getFullYear()).toBe(2026)
  })

  it('rolls the year back for a fall deadline read in January', () => {
    const d = parseDueDate('Dec 12 at 11:59PM', { now: at('2026-01-10T09:00:00') })!
    expect(d.getFullYear()).toBe(2025)
  })

  it('keeps the current year for an in-term deadline', () => {
    const d = parseDueDate('Oct 04 at 4:00PM', { now: at('2025-10-01T09:00:00') })!
    expect(d.getFullYear()).toBe(2025)
  })

  it('prefers the term window over proximity to now', () => {
    // Read in Aug 2026, a Fall 2025 course's "Dec 12" belongs to 2025 even
    // though Dec 2026 is closer to today.
    const d = parseDueDate('Dec 12 at 11:59PM', { now: at('2026-08-20T09:00:00'), term: 'Fall 2025' })!
    expect(d.getFullYear()).toBe(2025)
  })

  it('honors an explicit year when present', () => {
    const d = parseDueDate('October 4, 2023 at 4:00PM', { now: at('2025-09-15T12:00:00') })!
    expect(d.getFullYear()).toBe(2023)
  })

  it('prefers a machine-readable ISO timestamp', () => {
    const d = parseDueDate('2025-10-04T16:00:00-07:00', { now: at('2030-01-01T00:00:00') })!
    expect(d.toISOString()).toBe('2025-10-04T23:00:00.000Z')
  })

  it('defaults to end of day when no time is given', () => {
    const d = parseDueDate('Oct 04', { now: at('2025-09-15T12:00:00') })!
    expect(d.getHours()).toBe(23)
    expect(d.getMinutes()).toBe(59)
  })

  it('never rolls an impossible date over into the next month', () => {
    // Feb 29 must resolve to a real leap day, never to Mar 1.
    const d = parseDueDate('Feb 29 at 1:00PM', { now: at('2027-02-01T00:00:00') })!
    expect(d.getMonth()).toBe(1)
    expect(d.getDate()).toBe(29)
    expect(d.getFullYear()).toBe(2028)
  })

  it('returns null when no candidate year makes the date real', () => {
    // Feb 30 does not exist in any year.
    expect(parseDueDate('Feb 30 at 1:00PM', { now: at('2027-02-01T00:00:00') })).toBeNull()
    expect(parseDueDate('Apr 31 at 1:00PM', { now: at('2027-04-01T00:00:00') })).toBeNull()
  })

  it('returns null on unparseable text', () => {
    expect(parseDueDate('No due date', {})).toBeNull()
    expect(parseDueDate('', {})).toBeNull()
    expect(parseDueDate('Smorgasbord 99', {})).toBeNull()
  })
})

describe('termWindow', () => {
  it('spans a fall term into the following January', () => {
    const w = termWindow('Fall 2025')!
    expect(w.start.getFullYear()).toBe(2025)
    expect(w.end.getFullYear()).toBe(2026)
  })

  it('reads abbreviated terms', () => {
    expect(termWindow("Spring '26")!.start.getFullYear()).toBe(2026)
  })

  it('returns null for non-terms', () => {
    expect(termWindow('CS 70')).toBeNull()
    expect(termWindow(undefined)).toBeNull()
  })
})

describe('looksLikeDueDate', () => {
  it('accepts dates and rejects noise', () => {
    expect(looksLikeDueDate('Oct 04 at 4:00PM')).toBe(true)
    expect(looksLikeDueDate('2025-10-04T16:00:00Z')).toBe(true)
    expect(looksLikeDueDate('2 days left')).toBe(false)
    expect(looksLikeDueDate('Submitted')).toBe(false)
  })
})
