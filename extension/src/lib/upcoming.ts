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
  /** Kept so the UI can derive a stable per-course colour. */
  courseId: string
  due: Date
  submitted: boolean
  overdue: boolean
  url?: string
}

export interface UpcomingGroup {
  label: string
  items: UpcomingItem[]
}

/**
 * Rules for what counts as worth showing.
 *
 * Overdue work you can no longer submit would otherwise sit in the list -- and
 * in the badge count -- forever, so it ages out, and can also be dismissed
 * outright.
 */
export interface VisibilityOptions {
  now?: Date
  hideSubmitted?: boolean
  /** Keys the user dismissed by hand. */
  dismissed?: readonly string[]
  /**
   * Drop unsubmitted overdue work once it is older than this many days.
   * 0 keeps overdue work indefinitely.
   */
  hideOverdueAfterDays?: number
}

export interface UpcomingOptions extends VisibilityOptions {
  /** How far ahead to look. */
  days?: number
  /** Cap on rendered rows; the remainder is reported as hiddenCount. */
  max?: number
  /**
   * Collapse the overdue group out of view.
   *
   * Purely visual, unlike `dismissed` and `hideOverdueAfterDays`: the work
   * still exists, so it keeps counting toward the badge. This is the
   * non-destructive way to tidy the list.
   */
  hideOverdue?: boolean
}

/** Applies the visibility rules shared by the deadline list and the badge. */
export function filterVisible(
  cached: CachedAssignment[],
  opts: VisibilityOptions = {},
): CachedAssignment[] {
  const now = opts.now ?? new Date()
  const dismissed = new Set(opts.dismissed ?? [])
  const graceDays = opts.hideOverdueAfterDays ?? 0
  const graceMs = graceDays > 0 ? graceDays * 86_400_000 : Infinity

  return cached.filter((c) => {
    if (dismissed.has(c.key)) return false

    const t = new Date(c.dueIso).getTime()
    if (Number.isNaN(t)) return false

    const overdue = t < now.getTime()
    // Submitted work that is already past due is simply done.
    if (overdue && c.submitted) return false
    if (opts.hideSubmitted && c.submitted) return false
    // Aged-out overdue work: you are not going to submit it now.
    if (overdue && now.getTime() - t > graceMs) return false
    return true
  })
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
  for (const c of filterVisible(cached, opts)) {
    const due = new Date(c.dueIso)
    const overdue = due.getTime() < now.getTime()
    if (due.getTime() >= horizon) continue

    items.push({
      key: c.key,
      title: c.title,
      course: c.courseShortName,
      courseId: c.courseId,
      due,
      submitted: c.submitted,
      overdue,
      ...(c.url ? { url: c.url } : {}),
    })
  }

  items.sort((a, b) => a.due.getTime() - b.due.getTime())

  // Counted before collapsing, so the UI can report how many are hidden.
  const overdueCount = items.filter((i) => i.overdue).length
  const visible = opts.hideOverdue ? items.filter((i) => !i.overdue) : items
  const shown = visible.slice(0, max)

  // Group in chronological order, with everything overdue collected up front.
  const groups: UpcomingGroup[] = []
  for (const item of shown) {
    const label = item.overdue ? 'Overdue' : labelFor(item.due, now)
    const last = groups[groups.length - 1]
    if (last && last.label === label) last.items.push(item)
    else groups.push({ label, items: [item] })
  }

  return { groups, hiddenCount: visible.length - shown.length, overdueCount }
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
  opts: VisibilityOptions & { soonHours?: number } = {},
): BadgeState {
  const now = opts.now ?? new Date()
  const soonHours = opts.soonHours ?? 48
  const soonCutoff = now.getTime() + soonHours * 3_600_000
  let overdue = 0
  let soon = 0

  // Same filter as the list: a dismissed or aged-out item must not keep the
  // badge lit, which was the whole point of dismissing it.
  for (const c of filterVisible(cached, opts)) {
    if (c.submitted) continue
    const t = new Date(c.dueIso).getTime()
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

/**
 * Compact relative time: "in 25m", "in 4h", "in 3d", "2d ago".
 *
 * More useful than a clock time on a deadline list — "in 4h" tells you what to
 * do now, "4:00 PM" makes you work it out.
 */
export function relativeTime(due: Date, now: Date = new Date()): string {
  const ms = due.getTime() - now.getTime()
  const past = ms < 0
  const mins = Math.floor(Math.abs(ms) / 60_000)

  let out: string
  if (mins < 1) out = 'now'
  else if (mins < 60) out = `${mins}m`
  else if (mins < 60 * 24) out = `${Math.floor(mins / 60)}h`
  else out = `${Math.floor(mins / (60 * 24))}d`

  if (out === 'now') return 'now'
  return past ? `${out} ago` : `in ${out}`
}

/** Urgency band used to colour a row. */
export type Urgency = 'overdue' | 'soon' | 'today' | 'later'

export function urgencyOf(due: Date, now: Date = new Date()): Urgency {
  const ms = due.getTime() - now.getTime()
  if (ms < 0) return 'overdue'
  if (ms <= 6 * 3_600_000) return 'soon'
  if (ms <= 24 * 3_600_000) return 'today'
  return 'later'
}
