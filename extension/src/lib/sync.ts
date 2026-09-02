import type { CalendarBackend, DesiredEvent, ManagedEvent } from './calendar/backend'
import { courseIdFromKey } from './calendar/backend'
import type { Assignment, Course, SyncSettings, SyncStats } from './types'

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
