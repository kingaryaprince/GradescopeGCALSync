import { describe, expect, it } from 'vitest'
import { buildSnapshot, diffForNotifications, fingerprint, type Snapshot } from '../src/lib/notify'
import { readSubmission } from '../src/lib/gradescope/parse'
import type { Assignment, Course } from '../src/lib/types'

const course: Course = {
  id: '100', shortName: 'CS 70', name: 'Discrete Math',
  term: 'Fall 2026', url: 'https://www.gradescope.com/courses/100',
}
const asg = (over: Partial<Assignment> = {}): Assignment => ({
  key: 'gsync:v1:c100:a501',
  courseId: '100',
  assignmentId: '501',
  title: 'Homework 5',
  due: new Date('2026-10-04T23:00:00Z'),
  dueRaw: 'Oct 04 at 4:00PM',
  dueIsExact: false,
  submitted: false,
  ...over,
})
const entries = (...a: Assignment[]) => a.map((assignment) => ({ assignment, course }))
const BOTH = { notifyGrades: true, notifyNewAssignments: true }

describe('readSubmission', () => {
  const cell = (html: string): Element => {
    const d = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html')
    return d.querySelector('div')!
  }

  it('parses a score', () => {
    const r = readSubmission(cell('18.0 / 20.0'))
    expect(r.score).toEqual({ earned: 18, total: 20 })
    expect(r.submitted).toBe(true)
  })

  it('treats "Submitted" as submitted with no score', () => {
    const r = readSubmission(cell('Submitted'))
    expect(r.score).toBeUndefined()
    expect(r.submitted).toBe(true)
  })

  // "No Submission" contains the substring "Submission"; the negative must win.
  it('does not read "No Submission" as submitted', () => {
    expect(readSubmission(cell('No Submission')).submitted).toBe(false)
  })

  it('handles an empty cell', () => {
    expect(readSubmission(cell('')).submitted).toBe(false)
    expect(readSubmission(undefined).submitted).toBe(false)
  })
})

describe('fingerprint', () => {
  it('distinguishes graded from ungraded', () => {
    expect(fingerprint(asg())).toBe('-')
    expect(fingerprint(asg({ score: { earned: 18, total: 20 } }))).toBe('18/20')
  })
})

describe('diffForNotifications', () => {
  // Without this guard the very first sync fires one notification per assignment.
  it('stays silent on the first sync', () => {
    expect(diffForNotifications(null, entries(asg()), BOTH)).toEqual([])
    expect(diffForNotifications({}, entries(asg()), BOTH)).toEqual([])
  })

  it('notifies when a score first appears', () => {
    const prev: Snapshot = { 'gsync:v1:c100:a501': '-' }
    const n = diffForNotifications(prev, entries(asg({ score: { earned: 18, total: 20 } })), BOTH)
    expect(n).toHaveLength(1)
    expect(n[0]!.title).toContain('graded')
    expect(n[0]!.body).toBe('18/20')
  })

  it('notifies when a score changes, showing both values', () => {
    const prev: Snapshot = { 'gsync:v1:c100:a501': '15/20' }
    const n = diffForNotifications(prev, entries(asg({ score: { earned: 18, total: 20 } })), BOTH)
    expect(n[0]!.title).toContain('score changed')
    expect(n[0]!.body).toBe('15/20 → 18/20')
  })

  it('says nothing when the score is unchanged', () => {
    const prev: Snapshot = { 'gsync:v1:c100:a501': '18/20' }
    expect(diffForNotifications(prev, entries(asg({ score: { earned: 18, total: 20 } })), BOTH)).toEqual([])
  })

  it('does not report a grade being withdrawn', () => {
    const prev: Snapshot = { 'gsync:v1:c100:a501': '18/20' }
    expect(diffForNotifications(prev, entries(asg()), BOTH)).toEqual([])
  })

  it('notifies about a newly published assignment', () => {
    const prev: Snapshot = { 'gsync:v1:c100:a999': '-' }
    const n = diffForNotifications(prev, entries(asg()), BOTH)
    expect(n).toHaveLength(1)
    expect(n[0]!.title).toContain('new assignment')
    expect(n[0]!.body).toContain('Homework 5')
  })

  it('respects each toggle independently', () => {
    const prev: Snapshot = { 'gsync:v1:c100:a999': '-' }
    const graded = asg({ key: 'gsync:v1:c100:a999', score: { earned: 1, total: 1 } })
    const fresh = asg({ key: 'gsync:v1:c100:a501' })

    const onlyGrades = diffForNotifications(prev, entries(graded, fresh), {
      notifyGrades: true, notifyNewAssignments: false,
    })
    expect(onlyGrades.map((x) => x.title)).toEqual(['CS 70: Homework 5 graded'])

    const onlyNew = diffForNotifications(prev, entries(graded, fresh), {
      notifyGrades: false, notifyNewAssignments: true,
    })
    expect(onlyNew.map((x) => x.title)).toEqual(['CS 70: new assignment'])

    expect(diffForNotifications(prev, entries(graded, fresh), {
      notifyGrades: false, notifyNewAssignments: false,
    })).toEqual([])
  })

  it('carries the assignment link so the notification can be clicked', () => {
    const prev: Snapshot = { 'gsync:v1:c100:a501': '-' }
    const url = 'https://www.gradescope.com/courses/100/assignments/501'
    const n = diffForNotifications(prev, entries(asg({ url, score: { earned: 1, total: 1 } })), BOTH)
    expect(n[0]!.url).toBe(url)
  })
})

describe('buildSnapshot', () => {
  it('maps every assignment key to its fingerprint', () => {
    expect(buildSnapshot([asg(), asg({ key: 'k2', score: { earned: 3, total: 4 } })])).toEqual({
      'gsync:v1:c100:a501': '-',
      k2: '3/4',
    })
  })
})
