import type { CalendarBackend, DesiredEvent, ManagedEvent } from './backend'
import { OAUTH_SETUP_HINT, isOAuthConfigured } from '../oauth'

const API = 'https://www.googleapis.com/calendar/v3'

/**
 * Marks every event this extension creates. Listing by this property is what
 * guarantees we only ever read back, modify, or delete our own events.
 */
const APP_TAG = 'gradescope-sync'

export class AuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

/**
 * Fails early when the build has no real OAuth client configured. Otherwise
 * Chrome forwards the placeholder to Google, which answers with the unhelpful
 * "OAuth2 request failed: Service responded with error: 'bad client id: {0}'".
 */
function assertOAuthConfigured(): void {
  if (!isOAuthConfigured()) throw new AuthError(OAUTH_SETUP_HINT)
}

/** Wraps chrome.identity, which is callback-based across Chrome versions. */
export function getAuthToken(interactive: boolean): Promise<string> {
  assertOAuthConfigured()
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      const err = chrome.runtime.lastError
      if (err || !token) {
        reject(new AuthError(err?.message ?? 'Google Calendar access was not granted.'))
        return
      }
      resolve(token as string)
    })
  })
}

function removeCachedToken(token: string): Promise<void> {
  return new Promise((resolve) => chrome.identity.removeCachedAuthToken({ token }, () => resolve()))
}

export async function revokeAccess(): Promise<void> {
  try {
    const token = await getAuthToken(false)
    await fetch(`https://oauth2.googleapis.com/revoke?token=${token}`, { method: 'POST' })
    await removeCachedToken(token)
  } catch {
    // Nothing cached means nothing to revoke.
  }
}

/**
 * Calls the Calendar API, refreshing a stale token once before giving up.
 * Chrome caches tokens aggressively and returns expired ones after sleep.
 */
async function api<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const token = await getAuthToken(false)
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })

  if (res.status === 401 && retry) {
    await removeCachedToken(token)
    return api<T>(path, init, false)
  }

  if (res.status === 204 || res.status === 200 || res.status === 201) {
    const text = await res.text()
    return (text ? JSON.parse(text) : {}) as T
  }

  let detail = ''
  try {
    detail = ((await res.json()) as { error?: { message?: string } }).error?.message ?? ''
  } catch {
    /* body was not JSON */
  }

  if (res.status === 403 && /rate|quota/i.test(detail)) {
    throw new Error('Google Calendar rate limit reached. Try again in a few minutes.')
  }
  if (res.status === 403 || res.status === 401) {
    throw new AuthError(detail || 'Google Calendar denied the request. Reconnect your account.')
  }
  if (res.status === 404) {
    throw new Error('That calendar no longer exists. Pick a different one in Settings.')
  }
  throw new Error(`Google Calendar error ${res.status}${detail ? `: ${detail}` : ''}`)
}

interface GEvent {
  id: string
  summary?: string
  start?: { dateTime?: string; date?: string }
  extendedProperties?: { private?: Record<string, string> }
}

export interface CalendarSummary {
  id: string
  summary: string
  primary?: boolean
  accessRole: string
}

export async function listCalendars(): Promise<CalendarSummary[]> {
  const res = await api<{ items?: CalendarSummary[] }>('/users/me/calendarList?minAccessRole=writer&maxResults=250')
  return res.items ?? []
}

export async function createCalendar(summary: string): Promise<CalendarSummary> {
  return api<CalendarSummary>('/calendars', {
    method: 'POST',
    body: JSON.stringify({ summary, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
  })
}

function toApiEvent(e: DesiredEvent) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return {
    summary: e.summary,
    description: e.description,
    start: { dateTime: e.start.toISOString(), timeZone },
    end: { dateTime: e.end.toISOString(), timeZone },
    // Deadlines should not make the user look busy.
    transparency: 'transparent',
    source: e.url ? { title: 'Gradescope', url: e.url } : undefined,
    reminders: {
      useDefault: false,
      overrides: e.reminderMinutes.map((minutes) => ({ method: 'popup', minutes })),
    },
    extendedProperties: {
      private: { gsyncApp: APP_TAG, gsyncKey: e.key, gsyncCourse: e.courseId },
    },
  }
}

export class GoogleCalendarBackend implements CalendarBackend {
  constructor(private readonly calendarId: string) {}

  private get base(): string {
    return `/calendars/${encodeURIComponent(this.calendarId)}/events`
  }

  /** Reads back only events tagged as ours, paging until exhausted. */
  async listManaged(): Promise<ManagedEvent[]> {
    const out: ManagedEvent[] = []
    let pageToken: string | undefined

    // Bound the scan to a window around the current academic year.
    const timeMin = new Date(Date.now() - 400 * 24 * 3600 * 1000).toISOString()

    do {
      const qs = new URLSearchParams({
        privateExtendedProperty: `gsyncApp=${APP_TAG}`,
        singleEvents: 'true',
        maxResults: '2500',
        timeMin,
      })
      if (pageToken) qs.set('pageToken', pageToken)

      const res = await api<{ items?: GEvent[]; nextPageToken?: string }>(`${this.base}?${qs}`)
      for (const item of res.items ?? []) {
        const key = item.extendedProperties?.private?.gsyncKey
        const startIso = item.start?.dateTime ?? item.start?.date
        // Without a key we cannot safely match or delete it, so ignore it.
        if (!key || !startIso) continue
        out.push({ id: item.id, key, startIso, summary: item.summary ?? '' })
      }
      pageToken = res.nextPageToken
    } while (pageToken)

    return out
  }

  async insert(event: DesiredEvent): Promise<void> {
    await api(this.base, { method: 'POST', body: JSON.stringify(toApiEvent(event)) })
  }

  async update(id: string, event: DesiredEvent): Promise<void> {
    await api(`${this.base}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(toApiEvent(event)),
    })
  }

  async remove(id: string): Promise<void> {
    try {
      await api(`${this.base}/${encodeURIComponent(id)}`, { method: 'DELETE' })
    } catch (err) {
      // Already gone is a success for our purposes.
      if (err instanceof Error && /410|404|no longer exists/i.test(err.message)) return
      throw err
    }
  }
}
