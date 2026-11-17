import { buildIcs, icsFilename } from './lib/calendar/ics'
import {
  GoogleCalendarBackend,
  createCalendar,
  getAuthToken,
  listCalendars,
  revokeAccess,
} from './lib/calendar/gcal'
import { fromWire, fail, ok, type Request, type Response, type ScrapeAssignmentsData, type ScrapeCoursesData } from './lib/messages'
import {
  loadAssignmentCache,
  loadCourseCache,
  loadDismissed,
  loadReport,
  saveAssignmentCache,
  loadSettings,
  saveCourseCache,
  saveReport,
  saveSettings,
  setGoogleConnected,
  isGoogleConnected,
} from './lib/storage'
import { buildSnapshot, diffForNotifications, fireNotices, registerNotificationClicks, type Snapshot } from './lib/notify'
import {
  buildDesiredEvents,
  carryForward,
  everyCourseSignedOut,
  mergeSnapshot,
  reconcile,
  shouldInclude,
  shouldResyncAfterSignIn,
} from './lib/sync'
import { groupCoursesByTerm } from './lib/terms'
import { badgeState, type CachedAssignment } from './lib/upcoming'
import type { Assignment, Course, SyncReport } from './lib/types'

const OFFSCREEN_PATH = 'offscreen.html'
const ALARM = 'gradescope-autosync'
const SNAPSHOT_KEY = 'gradeSnapshot'
/** 15 minutes. Chrome allows tighter alarms, but Gradescope should not be polled harder. */
export const MIN_SYNC_HOURS = 0.25

// ------------------------- offscreen plumbing -------------------------

let creating: Promise<void> | null = null

/** Creates the offscreen document once; createDocument throws if one exists. */
async function ensureOffscreen(): Promise<void> {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
  })
  if (existing.length > 0) return

  if (creating) {
    await creating
    return
  }
  creating = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['DOM_PARSER' as chrome.offscreen.Reason],
    justification: 'Parse Gradescope assignment pages, which requires a DOM.',
  })
  try {
    await creating
  } finally {
    creating = null
  }
}

async function askOffscreen<T>(msg: Request): Promise<T> {
  await ensureOffscreen()
  const res = (await chrome.runtime.sendMessage({ ...msg, target: 'offscreen' })) as Response<T>
  if (!res) throw new Error('The Gradescope worker did not respond. Try again.')
  if (!res.ok) {
    const err = new Error(res.error)
    if (res.kind) err.name = res.kind
    throw err
  }
  return res.data
}

// ---------------------------- course list ----------------------------

/** Set by the last refreshCourses: its first fetch was signed out and the retry worked. */
let lastRecovered = false

async function refreshCourses(): Promise<Course[]> {
  const hadCache = (await loadCourseCache()).length > 0
  const data = await askOffscreen<ScrapeCoursesData>({ type: 'SCRAPE_COURSES' })
  lastRecovered = data.recovered === true
  await saveCourseCache(data.courses)

  // First successful load: opt the user into current and upcoming terms only.
  // Selecting every course meant scraping a page per course on every sync,
  // including terms that ended years ago.
  const settings = await loadSettings()
  if (!hadCache && settings.selectedCourseIds.length === 0 && data.courses.length > 0) {
    const recent = groupCoursesByTerm(data.courses)
      .filter((g) => g.isRecent)
      .flatMap((g) => g.courses.map((c) => c.id))
    await saveSettings({
      selectedCourseIds: recent.length > 0 ? recent : data.courses.map((c) => c.id),
    })
  }
  return data.courses
}

/** Fetches assignments for the selected courses, tracking per-course failures. */
async function collectAssignments(courses: Course[]): Promise<{
  entries: Array<{ assignment: Assignment; course: Course }>
  scrapedOk: Set<string>
  warnings: string[]
  signedOut: number
}> {
  const entries: Array<{ assignment: Assignment; course: Course }> = []
  const scrapedOk = new Set<string>()
  const warnings: string[] = []
  let signedOut = 0

  for (const course of courses) {
    try {
      const data = await askOffscreen<ScrapeAssignmentsData>({ type: 'SCRAPE_ASSIGNMENTS', course })
      scrapedOk.add(course.id)
      for (const a of data.assignments) entries.push({ assignment: fromWire(a), course })
      for (const w of data.warnings) warnings.push(`${course.shortName}: ${w}`)

      // Early warning that Gradescope's markup moved: we still parsed the page,
      // but only via the generic fallback. Surfaced so breakage is visible
      // before it turns into silently missing assignments.
      if (data.strategy === 'structural') {
        warnings.push(
          `${course.shortName}: read using the fallback parser (Gradescope's page layout may have changed).`,
        )
      }
    } catch (err) {
      // Deliberately not added to scrapedOk, so reconcile will not treat this
      // course's existing events as stale and delete them.
      if (err instanceof Error && err.name === 'NotLoggedInError') signedOut++
      warnings.push(`${course.shortName}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { entries, scrapedOk, warnings, signedOut }
}

function signedOutError(): Error {
  const err = new Error('Gradescope signed this browser out. Sign in to Gradescope; Docket syncs again by itself once you do.')
  err.name = 'NotLoggedInError'
  return err
}

/**
 * The popup cache for this run. Courses that failed keep their previous rows
 * (see carryForward), and in that case the "as of" time is left where it was:
 * stamping now on partly old data would claim more freshness than there is.
 */
async function saveRunCache(
  entries: Array<{ assignment: Assignment; course: Course }>,
  selected: Course[],
  scrapedOk: Set<string>,
): Promise<number> {
  const previous = await loadAssignmentCache()
  const items = carryForward(toCache(entries), previous.items, {
    selectedIds: selected.map((c) => c.id),
    readIds: scrapedOk,
  })
  const complete = selected.every((c) => scrapedOk.has(c.id))
  await saveAssignmentCache(items, complete || previous.at === null ? Date.now() : previous.at)
  return items.length
}

/** Gradescope's long-lived sign-in cookie, for the report. Never reads its value out. */
async function rememberedSignIn(): Promise<{ present: boolean; expiresAt?: number } | undefined> {
  try {
    const c = await chrome.cookies.get({ url: 'https://www.gradescope.com/', name: 'remember_me' })
    if (!c) return { present: false }
    return { present: true, ...(c.expirationDate ? { expiresAt: Math.round(c.expirationDate * 1000) } : {}) }
  } catch {
    return undefined                       // cookies permission missing in an old build
  }
}

/** Flattens scraped assignments into the shape the popup dashboard renders. */
function toCache(entries: Array<{ assignment: Assignment; course: Course }>): CachedAssignment[] {
  return entries
    .filter((e) => e.assignment.due)
    .map(({ assignment: a, course }) => ({
      key: a.key,
      title: a.title,
      courseId: a.courseId,
      courseShortName: course.shortName,
      dueIso: a.due!.toISOString(),
      submitted: a.submitted,
      ...(a.url ? { url: a.url } : {}),
    }))
}

/**
 * Scrapes deadlines and updates the popup cache without touching Google
 * Calendar, so the dashboard works before (or without) connecting an account.
 */
async function refreshDeadlines(): Promise<{ count: number; warnings: string[] }> {
  const settings = await loadSettings()
  const all = await refreshCourses()
  const selected = all.filter((c) => settings.selectedCourseIds.includes(c.id))
  const { entries, scrapedOk, warnings, signedOut } = await collectAssignments(selected)
  if (everyCourseSignedOut(selected.length, scrapedOk.size, signedOut)) throw signedOutError()
  const count = await saveRunCache(entries, selected, scrapedOk)
  await updateBadge()
  return { count, warnings }
}

// ------------------------------- sync -------------------------------

async function runSync(): Promise<SyncReport> {
  const started = Date.now()
  const previous = await loadReport()
  const lastOkAt = previous?.ok ? previous.at : previous?.lastOkAt
  try {
    const settings = await loadSettings()
    const all = await refreshCourses()
    const selected = all.filter((c) => settings.selectedCourseIds.includes(c.id))

    if (selected.length === 0) {
      throw new Error('No courses selected. Choose the courses you want synced.')
    }

    const { entries, scrapedOk, warnings, signedOut } = await collectAssignments(selected)
    // The list loaded but every course page bounced to sign-in: the session
    // expired mid-run. That is a failure, not a success with warnings.
    if (everyCourseSignedOut(selected.length, scrapedOk.size, signedOut)) throw signedOutError()
    const desired = buildDesiredEvents(entries, settings)

    // Diff before saving the new snapshot, and only over courses we actually
    // read, so a failed fetch cannot look like a batch of new assignments.
    const readEntries = entries.filter((e) => scrapedOk.has(e.course.id))
    if (settings.notifyGrades || settings.notifyNewAssignments) {
      const stored = await chrome.storage.local.get(SNAPSHOT_KEY)
      const notices = diffForNotifications(
        (stored[SNAPSHOT_KEY] as Snapshot | undefined) ?? null,
        readEntries,
        {
          notifyGrades: settings.notifyGrades,
          notifyNewAssignments: settings.notifyNewAssignments,
        },
      )
      if (notices.length > 0) await fireNotices(notices)
    }
    // Merge, not replace: a course that failed this run keeps its old
    // fingerprints, so its next good read is not a burst of "new" notices.
    const prevSnap = ((await chrome.storage.local.get(SNAPSHOT_KEY))[SNAPSHOT_KEY] as Snapshot | undefined) ?? null
    await chrome.storage.local.set({
      [SNAPSHOT_KEY]: mergeSnapshot(prevSnap, buildSnapshot(readEntries.map((e) => e.assignment)), scrapedOk),
    })

    // Safe to prune: courses we read successfully, plus courses the user turned
    // off (so their leftover events get cleaned up).
    const deletable = new Set(scrapedOk)
    for (const c of all) if (!settings.selectedCourseIds.includes(c.id)) deletable.add(c.id)

    await saveRunCache(readEntries, selected, scrapedOk)

    const backend = new GoogleCalendarBackend(settings.calendarId)
    const { stats, warnings: syncWarnings } = await reconcile(desired, backend, {
      deletableCourseIds: deletable,
      removeStale: settings.removeStale,
    })

    const report: SyncReport = {
      ...stats,
      at: started,
      ok: true,
      warnings: [...warnings, ...syncWarnings],
      ...(lastRecovered ? { recovered: true } : {}),
    }
    await saveReport(report)
    await setGoogleConnected(true)
    await updateBadge()
    return report
  } catch (err) {
    const signedOut = err instanceof Error && err.name === 'NotLoggedInError'
    const remembered = signedOut ? await rememberedSignIn() : undefined
    const report: SyncReport = {
      created: 0, updated: 0, deleted: 0, skipped: 0, failed: 0,
      at: started,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      warnings: [],
      ...(lastOkAt ? { lastOkAt } : {}),
      ...(signedOut ? { signedOut: true } : {}),
      ...(remembered ? { remembered } : {}),
    }
    await saveReport(report)
    await updateBadge()
    return report
  }
}

/**
 * Badge shows outstanding work, except when the last sync failed -- a broken
 * sync means the counts are stale, so surfacing the failure matters more.
 */
async function updateBadge(): Promise<void> {
  const report = await loadReport()
  const failed = report !== null && !report.ok
  const { items } = await loadAssignmentCache()
  const settings = await loadSettings()
  // A failed sync keeps the count with a "!" beside it: the cached deadlines
  // are still right more often than not, and hiding them helps nobody.
  const b = badgeState(items, {
    dismissed: await loadDismissed(),
    hideOverdueAfterDays: settings.hideOverdueAfterDays,
    syncFailed: failed,
  })
  void chrome.action.setBadgeText({ text: b.text })
  void chrome.action.setBadgeBackgroundColor({ color: b.color })
  void chrome.action.setTitle({
    title: failed ? `Docket · ${b.title}: ${report?.error ?? 'unknown error'}` : `Docket · ${b.title}`,
  })
}

async function exportIcs(): Promise<{ ics: string; filename: string; count: number }> {
  const settings = await loadSettings()
  const all = await refreshCourses()
  const selected = all.filter((c) => settings.selectedCourseIds.includes(c.id))
  const { entries } = await collectAssignments(selected.length > 0 ? selected : all)

  const kept = entries.filter((e) => e.assignment.due && shouldInclude(e.assignment.title, settings))
  const ics = buildIcs(kept, {
    calendarName: 'Gradescope',
    durationMinutes: settings.durationMinutes,
    reminderMinutes: settings.reminderMinutes,
    prefixCourse: settings.prefixCourse,
  })
  return { ics, filename: icsFilename(settings), count: kept.length }
}

// ----------------------------- messaging -----------------------------

chrome.runtime.onMessage.addListener(
  (msg: Request & { target?: string }, _sender, sendResponse: (r: Response) => void) => {
    // Offscreen has its own listener; ignore anything addressed to it.
    if (msg.target === 'offscreen') return false

    void (async () => {
      try {
        switch (msg.type) {
          case 'SYNC_NOW':
            sendResponse(ok({ report: await runSync() }))
            break
          case 'REFRESH_COURSES':
            sendResponse(ok({ courses: await refreshCourses() }))
            break
          case 'REFRESH_DEADLINES':
            sendResponse(ok(await refreshDeadlines()))
            break
          case 'EXPORT_ICS':
            sendResponse(ok(await exportIcs()))
            break
          case 'CONNECT_GOOGLE':
            await getAuthToken(true)
            await setGoogleConnected(true)
            sendResponse(ok({ connected: true }))
            break
          case 'DISCONNECT_GOOGLE':
            await revokeAccess()
            await setGoogleConnected(false)
            sendResponse(ok({ connected: false }))
            break
          case 'LIST_CALENDARS':
            sendResponse(ok({ calendars: await listCalendars() }))
            break
          case 'CREATE_CALENDAR':
            sendResponse(ok({ calendar: await createCalendar(msg.name) }))
            break
          default: {
            // Naming the request matters: during development the popup is
            // re-read from disk on every open while the service worker is not,
            // so a new popup can talk to a stale worker. "Unknown request"
            // alone gives no hint that an extension reload is what is needed.
            const unknown = (msg as { type?: string }).type ?? '(none)'
            sendResponse(
              fail(
                new Error(
                  `This build does not handle "${unknown}". Reload the extension on ` +
                    'chrome://extensions and try again.',
                ),
              ),
            )
            break
          }
        }
      } catch (err) {
        sendResponse(fail(err))
      }
    })()

    return true
  },
)

// ------------------------------ schedule ------------------------------

async function installAlarm(): Promise<void> {
  const settings = await loadSettings()
  await chrome.alarms.clear(ALARM)
  if (!settings.autoSync) return
  chrome.alarms.create(ALARM, {
    // Floored at 15 minutes: each sync fetches one page per selected course,
    // so anything tighter hammers Gradescope for no practical benefit.
    periodInMinutes: Math.max(MIN_SYNC_HOURS, settings.autoSyncHours) * 60,
    delayInMinutes: 1,
  })
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) void runSync()
})

chrome.runtime.onInstalled.addListener((details) => {
  void installAlarm()
  void updateBadge()
  if (details.reason === 'install') void chrome.runtime.openOptionsPage()
})

chrome.runtime.onStartup.addListener(() => {
  void installAlarm()
  // Recompute on launch: yesterday's "due soon" may now be overdue.
  void updateBadge()
})

registerNotificationClicks()

// After a signed-out failure, the moment the user lands on a Gradescope page
// that is not part of signing in, sync. Recovery becomes "sign in to
// Gradescope", which they were about to do anyway. tab.url is only present for
// pages this extension has host permission for, which is exactly gradescope.com.
let resyncing = false
chrome.tabs.onUpdated.addListener((_tabId, info, tab) => {
  if (info.status !== 'complete' || resyncing) return
  void (async () => {
    if (!shouldResyncAfterSignIn(await loadReport(), tab.url)) return
    resyncing = true
    try {
      if (await isGoogleConnected()) await runSync()
      else await refreshDeadlines().then(() => saveReport({
        created: 0, updated: 0, deleted: 0, skipped: 0, failed: 0, at: Date.now(), ok: true, warnings: [],
      })).then(updateBadge)
    } catch {
      // still signed out (or offline): the report already says so
    } finally {
      resyncing = false
    }
  })()
})

// Keep the alarm in step with the user's schedule preference.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes['settings']) void installAlarm()
})
