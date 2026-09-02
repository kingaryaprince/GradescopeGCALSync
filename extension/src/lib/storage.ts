import { DEFAULT_SETTINGS, type Course, type SyncReport, type SyncSettings } from './types'

const KEYS = {
  settings: 'settings',
  report: 'lastReport',
  courses: 'courseCache',
  connected: 'googleConnected',
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

export async function setGoogleConnected(v: boolean): Promise<void> {
  await chrome.storage.local.set({ [KEYS.connected]: v })
}

export async function isGoogleConnected(): Promise<boolean> {
  const got = await chrome.storage.local.get(KEYS.connected)
  return got[KEYS.connected] === true
}
