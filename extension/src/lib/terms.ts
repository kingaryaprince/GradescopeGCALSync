import { termWindow } from './gradescope/dates'
import type { Course } from './types'

export interface CourseGroup {
  /** Display label, e.g. "Fall 2026". Courses with no term land in "Other". */
  term: string
  courses: Course[]
  /**
   * Expanded by default. True for terms that are current or upcoming, matching
   * how Gradescope itself hides older courses behind a disclosure.
   */
  isRecent: boolean
}

const UNKNOWN = 'Other'

/**
 * Groups courses by term, newest first, flagging which groups to show by
 * default.
 *
 * Term windows deliberately overlap (a summer term runs into September), so
 * more than one group can be "recent" — which is exactly what Gradescope does:
 * on 1 Sep 2026 it shows both Fall 2026 and Summer 2026 above "Hide older
 * courses".
 */
export function groupCoursesByTerm(courses: Course[], now: Date = new Date()): CourseGroup[] {
  const byTerm = new Map<string, Course[]>()
  for (const c of courses) {
    const key = c.term?.trim() || UNKNOWN
    const list = byTerm.get(key)
    if (list) list.push(c)
    else byTerm.set(key, [c])
  }

  const groups = [...byTerm.entries()].map(([term, list]) => {
    const win = termWindow(term)
    return {
      term,
      courses: [...list].sort((a, b) => a.shortName.localeCompare(b.shortName)),
      // Unknown terms sort last and stay collapsed.
      sortKey: win ? win.start.getTime() : -Infinity,
      isRecent: win ? win.end >= now : false,
    }
  })

  groups.sort((a, b) => b.sortKey - a.sortKey)

  // Always leave at least one group open, even if every term is in the past.
  if (groups.length > 0 && !groups.some((g) => g.isRecent)) {
    groups[0]!.isRecent = true
  }

  return groups.map(({ term, courses: cs, isRecent }) => ({ term, courses: cs, isRecent }))
}
