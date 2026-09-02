import { describe, expect, it } from 'vitest'
import { buildIcs, icsDate } from '../src/lib/calendar/ics'
import type { Assignment, Course } from '../src/lib/types'

const course: Course = {
  id: '100', shortName: 'CS 70', name: 'Discrete Math',
  term: 'Fall 2025', url: 'https://www.gradescope.com/courses/100',
}
const mk = (over: Partial<Assignment> = {}): Assignment => ({
  key: 'gsync:v1:c100:a501',
  courseId: '100',
  assignmentId: '501',
  title: 'Homework 5',
  due: new Date('2025-10-04T23:00:00Z'),
  dueRaw: 'Oct 04 at 4:00PM',
  url: 'https://www.gradescope.com/courses/100/assignments/501',
  dueIsExact: false,
  submitted: false,
  ...over,
})

const lines = (s: string) => s.split('\r\n')

describe('buildIcs', () => {
  it('uses CRLF line endings throughout', () => {
    const ics = buildIcs([{ assignment: mk(), course }])
    expect(ics).toContain('\r\n')
    expect(ics.replace(/\r\n/g, '')).not.toContain('\n')
  })

  it('wraps events in a valid VCALENDAR', () => {
    const l = lines(buildIcs([{ assignment: mk(), course }]))
    expect(l[0]).toBe('BEGIN:VCALENDAR')
    expect(l).toContain('VERSION:2.0')
    expect(l.filter((x) => x === 'END:VCALENDAR')).toHaveLength(1)
    expect(l.filter((x) => x === 'BEGIN:VEVENT')).toHaveLength(1)
  })

  it('uses the stable key as UID so re-import updates in place', () => {
    expect(lines(buildIcs([{ assignment: mk(), course }]))).toContain('UID:gsync:v1:c100:a501')
  })

  it('emits UTC timestamps', () => {
    expect(icsDate(new Date('2025-10-04T23:00:00Z'))).toBe('20251004T230000Z')
    expect(lines(buildIcs([{ assignment: mk(), course }]))).toContain('DTSTART:20251004T230000Z')
  })

  it('honors the configured duration', () => {
    const l = lines(buildIcs([{ assignment: mk(), course }], { durationMinutes: 60 }))
    expect(l).toContain('DTEND:20251005T000000Z')
  })

  it('escapes backslash, semicolon and comma per RFC 5545', () => {
    // Title contains literally:  HW; part 1, v2\final
    const ics = buildIcs([{ assignment: mk({ title: 'HW; part 1, v2\\final' }), course }])
    expect(lines(ics)).toContain(String.raw`SUMMARY:CS 70: HW\; part 1\, v2\\final`)
  })

  it('escapes newlines instead of breaking the line structure', () => {
    const ics = buildIcs([{ assignment: mk({ dueRaw: 'line one\nline two' }), course }])
    const desc = lines(ics).find((x) => x.startsWith('DESCRIPTION:'))!
    expect(desc).toContain(String.raw`line one\nline two`)
  })

  it('folds lines to 75 octets', () => {
    const ics = buildIcs([{ assignment: mk({ title: 'X'.repeat(300) }), course }])
    for (const line of lines(ics)) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75)
    }
  })

  it('unfolds back to the original summary', () => {
    const title = 'Y'.repeat(200)
    const ics = buildIcs([{ assignment: mk({ title }), course }])
    const unfolded = ics.replace(/\r\n /g, '')
    expect(unfolded).toContain(`SUMMARY:CS 70: ${title}`)
  })

  it('adds one VALARM per configured reminder', () => {
    const l = lines(buildIcs([{ assignment: mk(), course }], { reminderMinutes: [1440, 60] }))
    expect(l.filter((x) => x === 'BEGIN:VALARM')).toHaveLength(2)
    expect(l).toContain('TRIGGER:-PT1440M')
    expect(l).toContain('TRIGGER:-PT60M')
  })

  it('skips assignments with no due date', () => {
    const ics = buildIcs([{ assignment: mk({ due: null }), course }])
    expect(ics).not.toContain('BEGIN:VEVENT')
  })

  it('prefixes the course name only when asked', () => {
    expect(buildIcs([{ assignment: mk(), course }], { prefixCourse: true })).toContain('SUMMARY:CS 70: Homework 5')
    expect(buildIcs([{ assignment: mk(), course }], { prefixCourse: false })).toContain('SUMMARY:Homework 5')
  })
})
