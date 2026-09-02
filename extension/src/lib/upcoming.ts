/**
 * View model for the popup's deadline list.
 *
 * Kept free of DOM and chrome APIs so the grouping and overdue rules are
 * directly testable.
 */

export interface CachedAssignment {
  key: string
  title: string
  courseId: string
  courseShortName: string
  /** ISO instant; Dates do not survive chrome.storage. */
  dueIso: string
  submitted: boolean
  url?: string
}

export interface UpcomingItem {
  key: string
  title: string
  course: string
  due: Date
  submitted: boolean
  overdue: boolean
  url?: string
}

export interface UpcomingGroup {
  label: string
  items: UpcomingItem[]
}

export interface UpcomingOptions {
  now?: Date
  /** How far ahead to look. */
  days?: number
  hideSubmitted?: boolean
  /** Cap on rendered rows; the remainder is reported as hiddenCount. */
  max?: number
}

export interface UpcomingView {
  groups: UpcomingGroup[]
  /** Rows dropped by `max`, so the UI can say "N more". */
  hiddenCount: number
  /** Unsubmitted work already past its deadline. */
  overdueCount: number
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** "Today", "Tomorrow", a weekday, or a dated label further out. */
function labelFor(due: Date, now: Date): string {
  const diff = Math.round((startOfDay(due) - startOfDay(now)) / 86_400_000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Tomorrow'
  if (diff > 1 && diff < 7) return due.toLocaleDateString([], { weekday: 'long' })
  return due.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
}

export function buildUpcoming(
  cached: CachedAssignment[],
  opts: UpcomingOptions = {},
): UpcomingView {
  const now = opts.now ?? new Date()
  const days = opts.days ?? 14
  const max = opts.max ?? 12
  const horizon = startOfDay(now) + (days + 1) * 86_400_000

  const items: UpcomingItem[] = []
  for (const c of cached) {
    const due = new Date(c.dueIso)
    if (Number.isNaN(due.getTime())) continue

    // Submitted work that is already past due is simply done; drop it.
    const overdue = due.getTime() < now.getTime()
    if (overdue && c.submitted) continue
    if (opts.hideSubmitted && c.submitted) continue
    if (due.getTime() >= horizon) continue

    items.push({
      key: c.key,
      title: c.title,
      course: c.courseShortName,
      due,
      submitted: c.submitted,
      overdue,
      ...(c.url ? { url: c.url } : {}),
    })
  }

  items.sort((a, b) => a.due.getTime() - b.due.getTime())

  const overdueCount = items.filter((i) => i.overdue).length
  const shown = items.slice(0, max)

  // Group in chronological order, with everything overdue collected up front.
  const groups: UpcomingGroup[] = []
  for (const item of shown) {
    const label = item.overdue ? 'Overdue' : labelFor(item.due, now)
    const last = groups[groups.length - 1]
    if (last && last.label === label) last.items.push(item)
    else groups.push({ label, items: [item] })
  }

  return { groups, hiddenCount: items.length - shown.length, overdueCount }
}

export interface BadgeState {
  text: string
  color: string
  /** Tooltip for the toolbar icon. */
  title: string
}

const RED = '#cf222e'
const AMBER = '#bf8700'
const GREEN = '#1a7f37'

/**
 * Toolbar badge summarising outstanding work.
 *
 * Overdue wins over due-soon, because a missed deadline is the more urgent
 * signal. Submitted work never counts.
 */
export function badgeState(
  cached: CachedAssignment[],
  now: Date = new Date(),
  soonHours = 48,
): BadgeState {
  const soonCutoff = now.getTime() + soonHours * 3_600_000
  let overdue = 0
  let soon = 0

  for (const c of cached) {
    if (c.submitted) continue
    const t = new Date(c.dueIso).getTime()
    if (Number.isNaN(t)) continue
    if (t < now.getTime()) overdue++
    else if (t <= soonCutoff) soon++
  }

  // The badge fits about four characters.
  const fmt = (n: number) => (n > 99 ? '99+' : String(n))

  if (overdue > 0) {
    return {
      text: fmt(overdue),
      color: RED,
      title: `${overdue} overdue assignment${overdue === 1 ? '' : 's'}`,
    }
  }
  if (soon > 0) {
    return {
      text: fmt(soon),
      color: AMBER,
      title: `${soon} assignment${soon === 1 ? '' : 's'} due in the next ${soonHours} hours`,
    }
  }
  return { text: '', color: GREEN, title: 'Nothing due soon' }
}
