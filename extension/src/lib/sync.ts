import type { CalendarBackend, DesiredEvent, ManagedEvent } from './calendar/backend'
import { courseIdFromKey } from './calendar/backend'
import type { Snapshot } from './notify'
import type { Assignment, Course, SyncReport, SyncSettings, SyncStats } from './types'
import type { CachedAssignment } from './upcoming'

/** Applies the user's allow/deny keyword filters to an assignment title. */
export function shouldInclude(title: string, settings: Pick<SyncSettings, 'allowKeywords' | 'denyKeywords'>): boolean {
  const t = title.toLowerCase()
  if (settings.denyKeywords.some((k) => k.trim() && t.includes(k.trim().toLowerCase()))) return false
  const allow = settings.allowKeywords.filter((k) => k.trim())
  if (allow.length > 0 && !allow.some((k) => t.includes(k.trim().toLowerCase()))) return false
  return true
}

export function buildDesiredEvents(
  entries: Array<{ assignment: Assignment; course: Course }>,
  settings: SyncSettings,
): DesiredEvent[] {
  const out: DesiredEvent[] = []
  for (const { assignment, course } of entries) {
    if (!assignment.due) continue
    if (!shouldInclude(assignment.title, settings)) continue
    // Dropping submitted work here also removes its existing event on the next
    // reconcile, which is the intent: the deadline no longer concerns you.
    if (settings.skipSubmitted && assignment.submitted) continue

    const description = [
      `Gradescope due: ${assignment.dueRaw}`,
      assignment.lateDue ? `Late deadline: ${assignment.lateDue.toLocaleString()}` : '',
      assignment.url ?? '',
    ]
      .filter(Boolean)
      .join('\n')

    out.push({
      key: assignment.key,
      courseId: assignment.courseId,
      summary: settings.prefixCourse ? `${course.shortName}: ${assignment.title}` : assignment.title,
      description,
      start: assignment.due,
      end: new Date(assignment.due.getTime() + settings.durationMinutes * 60_000),
      ...(assignment.url ? { url: assignment.url } : {}),
      reminderMinutes: settings.reminderMinutes,
    })
  }
  return out
}

/** True when the calendar copy has drifted from what we now want. */
function hasChanged(existing: ManagedEvent, desired: DesiredEvent): boolean {
  return (
    new Date(existing.startIso).getTime() !== desired.start.getTime() ||
    existing.summary !== desired.summary
  )
}

export interface ReconcileOptions {
  /**
   * Courses it is safe to delete stale events from: those scraped successfully
   * this run, plus those the user has deselected. A course whose fetch FAILED
   * must be excluded, otherwise a transient network error would wipe its events.
   */
  deletableCourseIds: Set<string>
  removeStale: boolean
}

export async function reconcile(
  desired: DesiredEvent[],
  backend: CalendarBackend,
  opts: ReconcileOptions,
): Promise<{ stats: SyncStats; warnings: string[] }> {
  const stats: SyncStats = { created: 0, updated: 0, deleted: 0, skipped: 0, failed: 0 }
  const warnings: string[] = []

  const managed = await backend.listManaged()
  const byKey = new Map<string, ManagedEvent>()
  for (const e of managed) {
    // Two events sharing a key means an earlier buggy run duplicated it; keep
    // the first and let the rest fall through to stale cleanup.
    if (!byKey.has(e.key)) byKey.set(e.key, e)
  }

  const desiredKeys = new Set(desired.map((d) => d.key))

  for (const d of desired) {
    const existing = byKey.get(d.key)
    try {
      if (!existing) {
        await backend.insert(d)
        stats.created++
      } else if (hasChanged(existing, d)) {
        // The whole point of a date-independent key: a moved deadline updates
        // the existing event rather than creating a second one.
        await backend.update(existing.id, d)
        stats.updated++
      } else {
        stats.skipped++
      }
    } catch (err) {
      stats.failed++
      warnings.push(`${d.summary}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (opts.removeStale) {
    const seen = new Set<string>()
    for (const e of managed) {
      const isDuplicate = seen.has(e.key)
      seen.add(e.key)

      if (desiredKeys.has(e.key) && !isDuplicate) continue

      const courseId = courseIdFromKey(e.key)
      // Unrecognized keys are left alone; we only clean up what we understand.
      if (!courseId || !opts.deletableCourseIds.has(courseId)) continue

      try {
        await backend.remove(e.id)
        stats.deleted++
      } catch (err) {
        stats.failed++
        warnings.push(`Removing "${e.summary}": ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  return { stats, warnings }
}

// ------------------------------------------------------------ partial runs
//
// A run can read some selected courses and fail on others (a network blip, a
// course that 500s, the session expiring mid-run). Calendar events already
// survive that: only courses read this run are deletable. The helpers below give
// the popup cache and the notification snapshot the same rule, so a failed
// course neither vanishes from the list nor comes back as a burst of "new
// assignment" notices.

/**
 * The popup cache after a run: fresh rows for courses read this run, plus the
 * previous rows of courses that are still selected but failed to load.
 * Deselected courses drop out.
 */
export function carryForward(
  fresh: CachedAssignment[],
  previous: CachedAssignment[],
  opts: { selectedIds: Iterable<string>; readIds: Iterable<string> },
): CachedAssignment[] {
  const selected = new Set(opts.selectedIds)
  const read = new Set(opts.readIds)
  const kept = previous.filter((c) => selected.has(c.courseId) && !read.has(c.courseId))
  const seen = new Set(fresh.map((c) => c.key))
  return [...fresh, ...kept.filter((c) => !seen.has(c.key))]
}

/**
 * The grade snapshot to store after a run. Courses read this run are replaced
 * wholesale (an assignment that disappeared is gone); every other course keeps
 * its previous fingerprints.
 */
export function mergeSnapshot(
  prev: Snapshot | null,
  fresh: Snapshot,
  readCourseIds: Iterable<string>,
): Snapshot {
  const read = new Set(readCourseIds)
  const out: Snapshot = {}
  for (const [key, value] of Object.entries(prev ?? {})) {
    const course = courseIdFromKey(key)
    if (course === null || !read.has(course)) out[key] = value
  }
  return { ...out, ...fresh }
}

/**
 * True when nothing was read and every selected course failed because the
 * session is gone. Reporting that as a success with warnings would write an
 * empty cache and leave the badge green.
 */
export function everyCourseSignedOut(selectedCount: number, readCount: number, signedOutCount: number): boolean {
  return selectedCount > 0 && readCount === 0 && signedOutCount === selectedCount
}

/**
 * Whether a finished page load should trigger a sync: the last run failed
 * because the browser was signed out, and the user is now on a Gradescope page
 * that is not part of signing in.
 */
export function shouldResyncAfterSignIn(report: SyncReport | null, url: string | undefined): boolean {
  if (!report || report.ok || !report.signedOut || !url) return false
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' || u.hostname !== 'www.gradescope.com') return false
  return !/^\/(login|logout|auth|saml|sso|users\/password)(\/|$)/.test(u.pathname)
}
