import type { CachedAssignment } from './upcoming'
import type { SavedLogin } from './gradescope/client'
import { DEFAULT_SETTINGS, type Course, type SyncReport, type SyncSettings } from './types'

const KEYS = {
  settings: 'settings',
  report: 'lastReport',
  courses: 'courseCache',
  connected: 'googleConnected',
  assignments: 'assignmentCache',
  assignmentsAt: 'assignmentCacheAt',
  dismissed: 'dismissedKeys',
  login: 'savedLogin',
} as const

export async function loadSettings(): Promise<SyncSettings> {
  const got = await chrome.storage.sync.get(KEYS.settings)
  // Merge so settings added in a later version get their defaults.
  return { ...DEFAULT_SETTINGS, ...(got[KEYS.settings] ?? {}) }
}

export async function saveSettings(patch: Partial<SyncSettings>): Promise<SyncSettings> {
  const next = { ...(await loadSettings()), ...patch }
  await chrome.storage.sync.set({ [KEYS.settings]: next })
  return next
}

export async function loadReport(): Promise<SyncReport | null> {
  const got = await chrome.storage.local.get(KEYS.report)
  return got[KEYS.report] ?? null
}

export async function saveReport(report: SyncReport): Promise<void> {
  await chrome.storage.local.set({ [KEYS.report]: report })
}

/** Cached course list so the popup can render instantly before a fetch lands. */
export async function loadCourseCache(): Promise<Course[]> {
  const got = await chrome.storage.local.get(KEYS.courses)
  return got[KEYS.courses] ?? []
}

export async function saveCourseCache(courses: Course[]): Promise<void> {
  await chrome.storage.local.set({ [KEYS.courses]: courses })
}

/** Deadlines the popup renders, cached so it opens instantly. */
export async function loadAssignmentCache(): Promise<{ items: CachedAssignment[]; at: number | null }> {
  const got = await chrome.storage.local.get([KEYS.assignments, KEYS.assignmentsAt])
  return { items: got[KEYS.assignments] ?? [], at: got[KEYS.assignmentsAt] ?? null }
}

/** `at` is when the data was read; defaults to now. */
export async function saveAssignmentCache(items: CachedAssignment[], at: number = Date.now()): Promise<void> {
  await chrome.storage.local.set({ [KEYS.assignments]: items, [KEYS.assignmentsAt]: at })
}

/**
 * Assignment keys the user dismissed by hand, stored with the time of
 * dismissal so they can be pruned later if needed.
 */
export async function loadDismissed(): Promise<string[]> {
  const got = await chrome.storage.local.get(KEYS.dismissed)
  return Object.keys(got[KEYS.dismissed] ?? {})
}

export async function dismissAssignment(key: string): Promise<void> {
  const got = await chrome.storage.local.get(KEYS.dismissed)
  const map: Record<string, number> = got[KEYS.dismissed] ?? {}
  map[key] = Date.now()
  await chrome.storage.local.set({ [KEYS.dismissed]: map })
}

export async function undismissAssignment(key: string): Promise<void> {
  const got = await chrome.storage.local.get(KEYS.dismissed)
  const map: Record<string, number> = got[KEYS.dismissed] ?? {}
  delete map[key]
  await chrome.storage.local.set({ [KEYS.dismissed]: map })
}

export async function clearDismissed(): Promise<void> {
  await chrome.storage.local.set({ [KEYS.dismissed]: {} })
}

export async function setGoogleConnected(v: boolean): Promise<void> {
  await chrome.storage.local.set({ [KEYS.connected]: v })
}

export async function isGoogleConnected(): Promise<boolean> {
  const got = await chrome.storage.local.get(KEYS.connected)
  return got[KEYS.connected] === true
}

/**
 * The saved Gradescope login lives in chrome.storage.local only: never
 * storage.sync, never in settings, never in a report. Sent nowhere except
 * gradescope.com when a sync finds the browser signed out.
 */
export async function loadLogin(): Promise<SavedLogin | null> {
  const got = await chrome.storage.local.get(KEYS.login)
  const v = got[KEYS.login]
  return v && typeof v.email === 'string' && typeof v.password === 'string' ? v : null
}

export async function saveLogin(login: SavedLogin): Promise<void> {
  await chrome.storage.local.set({ [KEYS.login]: login })
}

export async function clearLogin(): Promise<void> {
  await chrome.storage.local.remove(KEYS.login)
}
