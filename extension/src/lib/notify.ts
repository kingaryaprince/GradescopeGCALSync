import type { Assignment, Course } from './types'

/**
 * Grade and new-assignment notifications, built by diffing consecutive syncs.
 *
 * Gradescope already emails on grade release and assignment publish, so both of
 * these are opt-in. Their value is desktop delivery for people who mute those
 * emails, and catching score *changes* (a successful regrade) which are easier
 * to miss.
 */

/** Per-assignment fingerprint, small enough to keep in storage between syncs. */
export interface Snapshot {
  [key: string]: string
}

const UNGRADED = '-'

export function fingerprint(a: Assignment): string {
  return a.score ? `${a.score.earned}/${a.score.total}` : UNGRADED
}

export function buildSnapshot(assignments: Assignment[]): Snapshot {
  const snap: Snapshot = {}
  for (const a of assignments) snap[a.key] = fingerprint(a)
  return snap
}

export interface Notice {
  key: string
  title: string
  body: string
  url?: string
}

export interface DiffOptions {
  notifyGrades: boolean
  notifyNewAssignments: boolean
}

/**
 * Compares the previous snapshot against the current one.
 *
 * A missing or empty previous snapshot means this is the first sync, so
 * everything would look new. That must produce no notices at all, otherwise the
 * first run fires one notification per assignment.
 */
export function diffForNotifications(
  prev: Snapshot | null,
  entries: Array<{ assignment: Assignment; course: Course }>,
  opts: DiffOptions,
): Notice[] {
  if (!prev || Object.keys(prev).length === 0) return []

  const notices: Notice[] = []

  for (const { assignment: a, course } of entries) {
    const before = prev[a.key]
    const now = fingerprint(a)

    if (before === undefined) {
      if (opts.notifyNewAssignments) {
        notices.push({
          key: a.key,
          title: `${course.shortName}: new assignment`,
          body: a.due
            ? `${a.title} — due ${a.due.toLocaleString([], {
                month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
              })}`
            : a.title,
          ...(a.url ? { url: a.url } : {}),
        })
      }
      continue
    }

    if (!opts.notifyGrades || before === now || now === UNGRADED) continue

    notices.push({
      key: a.key,
      title: before === UNGRADED
        ? `${course.shortName}: ${a.title} graded`
        : `${course.shortName}: ${a.title} score changed`,
      body: before === UNGRADED ? now : `${before} → ${now}`,
      ...(a.url ? { url: a.url } : {}),
    })
  }

  return notices
}

const ID_PREFIX = 'gsync-notice:'

/** Fires desktop notifications, capped so a bulk grade release cannot flood. */
export async function fireNotices(notices: Notice[], max = 5): Promise<void> {
  const shown = notices.slice(0, max)

  for (const n of shown) {
    chrome.notifications.create(`${ID_PREFIX}${n.url ?? ''}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: n.title,
      message: n.body,
    })
  }

  if (notices.length > shown.length) {
    chrome.notifications.create(`${ID_PREFIX}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'Gradescope',
      message: `${notices.length - shown.length} more updates`,
    })
  }
}

/** Opens the assignment a notification came from. */
export function registerNotificationClicks(): void {
  chrome.notifications.onClicked.addListener((id) => {
    if (!id.startsWith(ID_PREFIX)) return
    const url = id.slice(ID_PREFIX.length)
    if (url) void chrome.tabs.create({ url })
    chrome.notifications.clear(id)
  })
}
