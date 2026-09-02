import type { CalendarSummary } from '../lib/calendar/gcal'
import type { Request, Response } from '../lib/messages'
import { OAUTH_SETUP_HINT, isOAuthConfigured } from '../lib/oauth'
import { isGoogleConnected, loadReport, loadSettings, saveSettings } from '../lib/storage'
import type { SyncReport, SyncSettings } from '../lib/types'

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const el = {
  banner: $<HTMLDivElement>('banner'),
  connState: $<HTMLParagraphElement>('conn-state'),
  connect: $<HTMLButtonElement>('connect'),
  disconnect: $<HTMLButtonElement>('disconnect'),
  calendar: $<HTMLSelectElement>('calendar'),
  newCalName: $<HTMLInputElement>('new-cal-name'),
  newCal: $<HTMLButtonElement>('new-cal'),
  duration: $<HTMLInputElement>('duration'),
  reminders: $<HTMLInputElement>('reminders'),
  prefix: $<HTMLInputElement>('prefix'),
  allow: $<HTMLInputElement>('allow'),
  deny: $<HTMLInputElement>('deny'),
  removeStale: $<HTMLInputElement>('remove-stale'),
  skipSubmitted: $<HTMLInputElement>('skip-submitted'),
  notifyGrades: $<HTMLInputElement>('notify-grades'),
  notifyNew: $<HTMLInputElement>('notify-new'),
  auto: $<HTMLInputElement>('auto'),
  autoHours: $<HTMLInputElement>('auto-hours'),
  report: $<HTMLPreElement>('report'),
  save: $<HTMLButtonElement>('save'),
  saved: $<HTMLSpanElement>('saved'),
}

function send<T>(msg: Request): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res: Response<T>) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message))
      if (!res) return reject(new Error('No response from the extension.'))
      if (!res.ok) return reject(new Error(res.error))
      resolve(res.data)
    })
  })
}

function banner(msg: string, kind: 'err' | 'warn'): void {
  el.banner.textContent = msg
  el.banner.className = `banner ${kind}`
  el.banner.hidden = false
}

const parseList = (v: string): string[] =>
  v.split(',').map((s) => s.trim()).filter(Boolean)

const parseMinutes = (v: string): number[] =>
  parseList(v)
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n >= 0)

function fillForm(s: SyncSettings): void {
  el.duration.value = String(s.durationMinutes)
  el.reminders.value = s.reminderMinutes.join(', ')
  el.prefix.checked = s.prefixCourse
  el.allow.value = s.allowKeywords.join(', ')
  el.deny.value = s.denyKeywords.join(', ')
  el.removeStale.checked = s.removeStale
  el.skipSubmitted.checked = s.skipSubmitted
  el.notifyGrades.checked = s.notifyGrades
  el.notifyNew.checked = s.notifyNewAssignments
  el.auto.checked = s.autoSync
  el.autoHours.value = String(s.autoSyncHours)
}

/** Keeps the chosen calendar selectable even before the API list arrives. */
function setCalendarOptions(cals: CalendarSummary[], current: string): void {
  el.calendar.replaceChildren()
  const seen = new Set<string>()
  for (const c of cals) {
    const o = document.createElement('option')
    o.value = c.id
    o.textContent = c.primary ? `${c.summary} (main calendar)` : c.summary
    el.calendar.append(o)
    seen.add(c.id)
  }
  if (!seen.has(current)) {
    const o = document.createElement('option')
    o.value = current
    o.textContent = current === 'primary' ? 'Main calendar' : current
    el.calendar.prepend(o)
  }
  el.calendar.value = current
}

function renderReport(r: SyncReport | null): void {
  if (!r) {
    el.report.textContent = 'No sync yet.'
    return
  }
  const lines = [
    `When:    ${new Date(r.at).toLocaleString()}`,
    `Result:  ${r.ok ? 'success' : 'failed'}`,
    `Events:  ${r.created} added, ${r.updated} updated, ${r.deleted} removed, ${r.skipped} unchanged, ${r.failed} failed`,
  ]
  if (r.error) lines.push(`Error:   ${r.error}`)
  if (r.warnings.length > 0) lines.push('', 'Skipped or noted:', ...r.warnings.map((w) => `  • ${w}`))
  el.report.textContent = lines.join('\n')
}

async function refreshConnection(): Promise<void> {
  if (!isOAuthConfigured()) {
    el.connState.textContent = 'Not available in this build.'
    el.connect.disabled = true
    el.disconnect.hidden = true
    el.newCal.disabled = true
    el.calendar.disabled = true
    setCalendarOptions([], (await loadSettings()).calendarId)
    banner(
      `${OAUTH_SETUP_HINT} Everything else on this page still applies to the .ics export, ` +
        'which you can download from the extension icon in your toolbar.',
      'warn',
    )
    return
  }

  const connected = await isGoogleConnected()
  el.connState.textContent = connected ? 'Connected.' : 'Not connected yet.'
  el.connect.hidden = connected
  el.disconnect.hidden = !connected

  if (!connected) return
  try {
    const { calendars } = await send<{ calendars: CalendarSummary[] }>({ type: 'LIST_CALENDARS' })
    const s = await loadSettings()
    setCalendarOptions(calendars, s.calendarId)
  } catch (err) {
    banner(`Could not list your calendars: ${(err as Error).message}`, 'warn')
  }
}

el.connect.addEventListener('click', () => {
  void (async () => {
    try {
      await send({ type: 'CONNECT_GOOGLE' })
      el.banner.hidden = true
      await refreshConnection()
    } catch (err) {
      banner((err as Error).message, 'err')
    }
  })()
})

el.disconnect.addEventListener('click', () => {
  void (async () => {
    await send({ type: 'DISCONNECT_GOOGLE' })
    await refreshConnection()
  })()
})

el.newCal.addEventListener('click', () => {
  void (async () => {
    const name = el.newCalName.value.trim() || 'Gradescope'
    el.newCal.disabled = true
    try {
      const { calendar } = await send<{ calendar: CalendarSummary }>({ type: 'CREATE_CALENDAR', name })
      await saveSettings({ calendarId: calendar.id })
      await refreshConnection()
      el.calendar.value = calendar.id
      el.saved.textContent = `Created “${name}”.`
    } catch (err) {
      banner((err as Error).message, 'err')
    } finally {
      el.newCal.disabled = false
    }
  })()
})

el.save.addEventListener('click', () => {
  void (async () => {
    await saveSettings({
      calendarId: el.calendar.value || 'primary',
      durationMinutes: Math.max(0, Number.parseInt(el.duration.value, 10) || 0),
      reminderMinutes: parseMinutes(el.reminders.value),
      prefixCourse: el.prefix.checked,
      allowKeywords: parseList(el.allow.value),
      denyKeywords: parseList(el.deny.value),
      removeStale: el.removeStale.checked,
      skipSubmitted: el.skipSubmitted.checked,
      notifyGrades: el.notifyGrades.checked,
      notifyNewAssignments: el.notifyNew.checked,
      autoSync: el.auto.checked,
      autoSyncHours: Math.min(168, Math.max(1, Number.parseInt(el.autoHours.value, 10) || 6)),
    })
    el.saved.textContent = 'Saved.'
    setTimeout(() => (el.saved.textContent = ''), 2000)
  })()
})

/**
 * The report is written by the background worker, which may run while this page
 * is already open. Without this listener the page would keep showing whatever
 * was true when it loaded (typically "No sync yet.") even after a sync landed.
 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes['lastReport']) {
    renderReport(changes['lastReport'].newValue as SyncReport | null)
  }
})

// Also re-read when the tab regains focus, covering anything missed while the
// page was in the background.
window.addEventListener('focus', () => void (async () => renderReport(await loadReport()))())

void (async () => {
  fillForm(await loadSettings())
  renderReport(await loadReport())
  await refreshConnection()
})()
