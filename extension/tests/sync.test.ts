import { describe, expect, it } from 'vitest'
import { buildDesiredEvents, reconcile, shouldInclude } from '../src/lib/sync'
import type { CalendarBackend, DesiredEvent, ManagedEvent } from '../src/lib/calendar/backend'
import { DEFAULT_SETTINGS, type Assignment, type Course, type SyncSettings } from '../src/lib/types'

/** In-memory calendar that records every mutation for assertions. */
class FakeCalendar implements CalendarBackend {
  events: ManagedEvent[]
  readonly log: string[] = []
  private nextId = 1000

  constructor(initial: ManagedEvent[] = []) {
    this.events = [...initial]
  }
  async listManaged() {
    return [...this.events]
  }
  async insert(e: DesiredEvent) {
    this.log.push(`insert:${e.key}`)
    this.events.push({ id: `id${this.nextId++}`, key: e.key, startIso: e.start.toISOString(), summary: e.summary })
  }
  async update(id: string, e: DesiredEvent) {
    this.log.push(`update:${id}:${e.key}`)
    const i = this.events.findIndex((x) => x.id === id)
    this.events[i] = { id, key: e.key, startIso: e.start.toISOString(), summary: e.summary }
  }
  async remove(id: string) {
    this.log.push(`remove:${id}`)
    this.events = this.events.filter((x) => x.id !== id)
  }
}

const course: Course = {
  id: '100', shortName: 'CS 70', name: 'Discrete Math',
  term: 'Fall 2025', url: 'https://www.gradescope.com/courses/100',
}
const asg = (over: Partial<Assignment> = {}): Assignment => ({
  key: 'gsync:v1:c100:a501',
  courseId: '100',
  assignmentId: '501',
  title: 'Homework 5',
  due: new Date('2025-10-04T23:00:00Z'),
  dueRaw: 'Oct 04 at 4:00PM',
  dueIsExact: false,
  ...over,
})
const settings = (over: Partial<SyncSettings> = {}): SyncSettings => ({ ...DEFAULT_SETTINGS, ...over })
const desiredFor = (a: Assignment, s = settings()) => buildDesiredEvents([{ assignment: a, course }], s)
const allCourses = { deletableCourseIds: new Set(['100']), removeStale: true }

describe('reconcile', () => {
  it('creates events that do not exist yet', async () => {
    const cal = new FakeCalendar()
    const { stats } = await reconcile(desiredFor(asg()), cal, allCourses)
    expect(stats.created).toBe(1)
    expect(cal.events).toHaveLength(1)
  })

  it('skips events that are already correct', async () => {
    const cal = new FakeCalendar()
    await reconcile(desiredFor(asg()), cal, allCourses)
    const { stats } = await reconcile(desiredFor(asg()), cal, allCourses)
    expect(stats).toMatchObject({ created: 0, updated: 0, skipped: 1, deleted: 0 })
  })

  // The headline bug in the original script: keying on the due timestamp meant a
  // rescheduled deadline produced a second event and orphaned the first.
  it('updates in place when a deadline moves, creating no duplicate', async () => {
    const cal = new FakeCalendar()
    await reconcile(desiredFor(asg()), cal, allCourses)

    const moved = asg({ due: new Date('2025-10-09T23:00:00Z'), dueRaw: 'Oct 09 at 4:00PM' })
    const { stats } = await reconcile(desiredFor(moved), cal, allCourses)

    expect(stats).toMatchObject({ created: 0, updated: 1, deleted: 0 })
    expect(cal.events).toHaveLength(1)
    expect(cal.events[0]!.startIso).toBe('2025-10-09T23:00:00.000Z')
  })

  it('updates in place when an assignment is renamed', async () => {
    const cal = new FakeCalendar()
    await reconcile(desiredFor(asg()), cal, allCourses)
    const { stats } = await reconcile(desiredFor(asg({ title: 'Homework 5 (revised)' })), cal, allCourses)
    expect(stats.updated).toBe(1)
    expect(cal.events).toHaveLength(1)
    expect(cal.events[0]!.summary).toBe('CS 70: Homework 5 (revised)')
  })

  it('removes events whose assignment disappeared', async () => {
    const cal = new FakeCalendar()
    await reconcile(desiredFor(asg()), cal, allCourses)
    const { stats } = await reconcile([], cal, allCourses)
    expect(stats.deleted).toBe(1)
    expect(cal.events).toHaveLength(0)
  })

  it('leaves stale events alone when removeStale is off', async () => {
    const cal = new FakeCalendar()
    await reconcile(desiredFor(asg()), cal, allCourses)
    const { stats } = await reconcile([], cal, { deletableCourseIds: new Set(['100']), removeStale: false })
    expect(stats.deleted).toBe(0)
    expect(cal.events).toHaveLength(1)
  })

  // A transient fetch failure must never be mistaken for "assignment deleted".
  it('does not delete events for a course that failed to scrape', async () => {
    const cal = new FakeCalendar()
    await reconcile(desiredFor(asg()), cal, allCourses)
    const { stats } = await reconcile([], cal, { deletableCourseIds: new Set(), removeStale: true })
    expect(stats.deleted).toBe(0)
    expect(cal.events).toHaveLength(1)
  })

  it('never touches events it did not create', async () => {
    const foreign: ManagedEvent = {
      id: 'user-event', key: 'not-ours', startIso: '2025-10-04T23:00:00.000Z', summary: 'Dentist',
    }
    const cal = new FakeCalendar([foreign])
    await reconcile([], cal, allCourses)
    expect(cal.log.filter((l) => l.includes('user-event'))).toHaveLength(0)
    expect(cal.events).toContainEqual(foreign)
  })

  it('cleans up duplicates left behind by earlier buggy runs', async () => {
    const dup: ManagedEvent[] = [
      { id: 'a', key: 'gsync:v1:c100:a501', startIso: '2025-10-04T23:00:00.000Z', summary: 'CS 70: Homework 5' },
      { id: 'b', key: 'gsync:v1:c100:a501', startIso: '2025-10-09T23:00:00.000Z', summary: 'CS 70: Homework 5' },
    ]
    const cal = new FakeCalendar(dup)
    const { stats } = await reconcile(desiredFor(asg()), cal, allCourses)
    expect(stats.deleted).toBe(1)
    expect(cal.events).toHaveLength(1)
    expect(cal.events[0]!.id).toBe('a')
  })

  it('counts a failure without aborting the rest of the sync', async () => {
    const cal = new FakeCalendar()
    cal.insert = async (e) => {
      if (e.key.endsWith('a501')) throw new Error('rate limited')
    }
    const two = [
      { assignment: asg(), course },
      { assignment: asg({ key: 'gsync:v1:c100:a502', assignmentId: '502', title: 'Project 1' }), course },
    ]
    const { stats, warnings } = await reconcile(buildDesiredEvents(two, settings()), cal, allCourses)
    expect(stats.failed).toBe(1)
    expect(stats.created).toBe(1)
    expect(warnings.join(' ')).toMatch(/rate limited/)
  })
})

describe('buildDesiredEvents', () => {
  it('drops assignments with no due date', () => {
    expect(desiredFor(asg({ due: null }))).toHaveLength(0)
  })

  it('applies the configured duration', () => {
    const [e] = desiredFor(asg(), settings({ durationMinutes: 45 }))
    expect(e!.end.getTime() - e!.start.getTime()).toBe(45 * 60_000)
  })

  it('includes the assignment link in the description', () => {
    const [e] = desiredFor(asg({ url: 'https://www.gradescope.com/courses/100/assignments/501' }))
    expect(e!.description).toContain('/assignments/501')
  })
})

describe('shouldInclude', () => {
  it('blocks denied keywords case-insensitively', () => {
    expect(shouldInclude('Attendance Week 6', { allowKeywords: [], denyKeywords: ['attendance'] })).toBe(false)
    expect(shouldInclude('Homework 5', { allowKeywords: [], denyKeywords: ['attendance'] })).toBe(true)
  })

  it('restricts to the allow list when one is set', () => {
    expect(shouldInclude('Homework 5', { allowKeywords: ['homework'], denyKeywords: [] })).toBe(true)
    expect(shouldInclude('Quiz 2', { allowKeywords: ['homework'], denyKeywords: [] })).toBe(false)
  })

  it('lets deny win over allow', () => {
    expect(shouldInclude('Homework 5 attendance', { allowKeywords: ['homework'], denyKeywords: ['attendance'] })).toBe(false)
  })

  it('ignores blank keyword entries', () => {
    expect(shouldInclude('Homework 5', { allowKeywords: ['  '], denyKeywords: ['', ' '] })).toBe(true)
  })
})
