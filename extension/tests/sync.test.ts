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
  submitted: false,
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

// ------------------------------------------------------------ partial runs
import {
  carryForward,
  everyCourseSignedOut,
  mergeSnapshot,
  shouldResyncAfterSignIn,
} from '../src/lib/sync'
import { fetchCourses, NotLoggedInError, type FetchedPage } from '../src/lib/gradescope/client'
import type { CachedAssignment } from '../src/lib/upcoming'
import type { SyncReport } from '../src/lib/types'

const row = (courseId: string, n: number): CachedAssignment => ({
  key: `gsync:v1:c${courseId}:a${n}`, title: `HW ${n}`, courseId, courseShortName: `C${courseId}`,
  dueIso: '2026-11-20T07:59:00.000Z', submitted: false,
})

describe('carryForward (a course that fails keeps its rows)', () => {
  it('keeps previous rows of a selected course that failed this run', () => {
    const prev = [row('100', 1), row('200', 2), row('200', 3)]
    const fresh = [row('100', 1), row('100', 4)]
    const out = carryForward(fresh, prev, { selectedIds: ['100', '200'], readIds: ['100'] })
    expect(out.map((r) => r.key)).toEqual([
      'gsync:v1:c100:a1', 'gsync:v1:c100:a4', 'gsync:v1:c200:a2', 'gsync:v1:c200:a3',
    ])
  })

  it('drops rows of a course that was read and no longer lists them', () => {
    const out = carryForward([], [row('100', 1)], { selectedIds: ['100'], readIds: ['100'] })
    expect(out).toEqual([])
  })

  it('drops rows of a deselected course even when it was not read', () => {
    const out = carryForward([row('100', 1)], [row('300', 9)], { selectedIds: ['100'], readIds: ['100'] })
    expect(out.map((r) => r.courseId)).toEqual(['100'])
  })
})

describe('mergeSnapshot (no notification burst after a failed course)', () => {
  it('keeps fingerprints of courses not read this run', () => {
    const prev = { 'gsync:v1:c100:a1': '-', 'gsync:v1:c200:a2': '18/20' }
    const fresh = { 'gsync:v1:c100:a1': '9/10' }
    expect(mergeSnapshot(prev, fresh, ['100'])).toEqual({
      'gsync:v1:c200:a2': '18/20', 'gsync:v1:c100:a1': '9/10',
    })
  })

  it('removes assignments that vanished from a course that was read', () => {
    const prev = { 'gsync:v1:c100:a1': '-', 'gsync:v1:c100:a2': '-' }
    expect(mergeSnapshot(prev, { 'gsync:v1:c100:a1': '-' }, ['100'])).toEqual({ 'gsync:v1:c100:a1': '-' })
  })

  it('a failed course does not look new on its next good read', async () => {
    const { diffForNotifications } = await import('../src/lib/notify')
    const c200: Course = { ...course, id: '200', shortName: 'DATA 101' }
    const a2 = asg({ key: 'gsync:v1:c200:a2', courseId: '200', assignmentId: '2', title: 'Project 3' })
    // run 1: both read. run 2: course 200 fails. run 3: both read again.
    let snap = mergeSnapshot(null, { 'gsync:v1:c100:a501': '-', 'gsync:v1:c200:a2': '-' }, ['100', '200'])
    snap = mergeSnapshot(snap, { 'gsync:v1:c100:a501': '-' }, ['100'])
    const notices = diffForNotifications(snap, [{ assignment: asg(), course }, { assignment: a2, course: c200 }],
      { notifyGrades: true, notifyNewAssignments: true })
    expect(notices).toEqual([])
  })
})

describe('everyCourseSignedOut', () => {
  it('is true only when nothing was read and every selected course bounced to sign-in', () => {
    expect(everyCourseSignedOut(3, 0, 3)).toBe(true)
    expect(everyCourseSignedOut(3, 0, 2)).toBe(false)      // one failed some other way
    expect(everyCourseSignedOut(3, 1, 2)).toBe(false)
    expect(everyCourseSignedOut(0, 0, 0)).toBe(false)
  })
})

describe('shouldResyncAfterSignIn', () => {
  const failed: SyncReport = {
    created: 0, updated: 0, deleted: 0, skipped: 0, failed: 0, at: 1, ok: false, warnings: [], signedOut: true,
  }
  it('fires on a normal Gradescope page after a signed-out failure', () => {
    expect(shouldResyncAfterSignIn(failed, 'https://www.gradescope.com/account')).toBe(true)
    expect(shouldResyncAfterSignIn(failed, 'https://www.gradescope.com/')).toBe(true)
    expect(shouldResyncAfterSignIn(failed, 'https://www.gradescope.com/courses/100')).toBe(true)
  })
  it('waits while the user is still signing in', () => {
    expect(shouldResyncAfterSignIn(failed, 'https://www.gradescope.com/login')).toBe(false)
    expect(shouldResyncAfterSignIn(failed, 'https://www.gradescope.com/auth/saml/berkeley')).toBe(false)
    expect(shouldResyncAfterSignIn(failed, 'https://www.gradescope.com/saml/consume')).toBe(false)
  })
  it('ignores other sites, other failures and good reports', () => {
    expect(shouldResyncAfterSignIn(failed, 'https://auth.berkeley.edu/cas/login')).toBe(false)
    expect(shouldResyncAfterSignIn(failed, 'https://www.gradescope.com.evil.example/')).toBe(false)
    expect(shouldResyncAfterSignIn(failed, undefined)).toBe(false)
    expect(shouldResyncAfterSignIn({ ...failed, signedOut: false }, 'https://www.gradescope.com/')).toBe(false)
    expect(shouldResyncAfterSignIn({ ...failed, ok: true }, 'https://www.gradescope.com/')).toBe(false)
    expect(shouldResyncAfterSignIn(null, 'https://www.gradescope.com/')).toBe(false)
  })
})

describe('fetchCourses session retry', () => {
  const page = (html: string, finalUrl = 'https://www.gradescope.com/account'): FetchedPage => ({
    doc: new DOMParser().parseFromString(html, 'text/html'), finalUrl, status: 200,
  })
  const login = () => page('<form action="/login"><input id="session_password"></form>', 'https://www.gradescope.com/login')
  const dash = () => page('<div class="courseList"></div>')

  it('loads "/" once and retries when the first answer is the login page', async () => {
    const calls: string[] = []
    const answers = [login(), dash(), dash()]
    const r = await fetchCourses(async (url) => { calls.push(url); return answers.shift()! })
    expect(calls).toEqual([
      'https://www.gradescope.com/account', 'https://www.gradescope.com/', 'https://www.gradescope.com/account',
    ])
    expect(r.recovered).toBe(true)
  })

  it('still throws NotLoggedInError when the retry is signed out too', async () => {
    const answers = [login(), login(), login()]
    await expect(fetchCourses(async () => answers.shift()!)).rejects.toBeInstanceOf(NotLoggedInError)
  })

  it('does not retry when already signed in', async () => {
    let n = 0
    const r = await fetchCourses(async () => { n++; return dash() })
    expect(n).toBe(1)
    expect(r.recovered).toBeUndefined()
  })
})
