import type { Request, Response, SyncNowData } from '../lib/messages'
import { isOAuthConfigured } from '../lib/oauth'
import { applyTheme, initTheme } from '../lib/theme'
import { groupCoursesByTerm, type CourseGroup } from '../lib/terms'
import { isGoogleConnected, loadAssignmentCache, loadCourseCache, loadReport, loadSettings, saveSettings } from '../lib/storage'
import { courseColor } from '../lib/colors'
import { buildUpcoming, relativeTime, urgencyOf, type CachedAssignment } from '../lib/upcoming'
import type { Course, SyncReport } from '../lib/types'

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const els = {
  banner: $<HTMLDivElement>('banner'),
  connect: $<HTMLElement>('connect'),
  connectBtn: $<HTMLButtonElement>('connect-btn'),
  courses: $<HTMLDivElement>('courses'),
  coursesEmpty: $<HTMLParagraphElement>('courses-empty'),
  refresh: $<HTMLButtonElement>('refresh'),
  selAll: $<HTMLButtonElement>('sel-all'),
  selNone: $<HTMLButtonElement>('sel-none'),
  sync: $<HTMLButtonElement>('sync'),
  ics: $<HTMLButtonElement>('ics'),
  status: $<HTMLElement>('status'),
  upcoming: $<HTMLDivElement>('upcoming'),
  toggleSubmitted: $<HTMLButtonElement>('toggle-submitted'),
  toggleCourses: $<HTMLButtonElement>('toggle-courses'),
  coursesCard: $<HTMLElement>('courses-card'),
  settings: $<HTMLButtonElement>('settings'),
  themeBtn: $<HTMLButtonElement>('theme-btn'),
}

const SEND_TIMEOUT_MS = 120_000

function send<T>(msg: Request): Promise<T> {
  return new Promise((resolve, reject) => {
    // Scraping many courses is slow, but it must still be bounded: without a
    // timeout a dropped response leaves the UI stuck in a loading state.
    const timer = setTimeout(
      () => reject(new Error('That took too long. Check your connection and try again.')),
      SEND_TIMEOUT_MS,
    )
    const done = <R>(fn: (v: R) => void) => (v: R) => {
      clearTimeout(timer)
      fn(v)
    }
    const ok_ = done(resolve as (v: unknown) => void)
    const bad = done(reject as (v: unknown) => void)

    chrome.runtime.sendMessage(msg, (res: Response<T>) => {
      if (chrome.runtime.lastError) return bad(new Error(chrome.runtime.lastError.message))
      if (!res) return bad(new Error('No response from the extension.'))
      if (!res.ok) {
        const e = new Error(res.error)
        if (res.kind) e.name = res.kind
        return bad(e)
      }
      ok_(res.data)
    })
  })
}

function setStatus(text: string, kind: '' | 'ok' | 'err' = ''): void {
  els.status.textContent = text
  els.status.className = `status muted ${kind}`.trim()
}

function showBanner(html: string, kind: 'err' | 'warn'): void {
  els.banner.innerHTML = html
  els.banner.className = `banner ${kind}`
  els.banner.hidden = false
}

function hideBanner(): void {
  els.banner.hidden = true
}

/** Not being signed in to Gradescope is the most common failure; make it actionable. */
function explain(err: Error): void {
  if (err.name === 'NotLoggedInError') {
    showBanner(
      'You are not signed in to Gradescope. <a href="https://www.gradescope.com/login" target="_blank" rel="noreferrer">Sign in</a>, then sync again.',
      'err',
    )
  } else if (err.name === 'AuthError') {
    showBanner('Google Calendar access is needed. Use “Connect Google Calendar” above.', 'err')
    els.connect.hidden = false
  } else {
    showBanner(err.message, 'err')
  }
}

let cachedDeadlines: CachedAssignment[] = []
let hideSubmitted = false

const timeOf = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

function upcomingRow(item: ReturnType<typeof buildUpcoming>['groups'][number]['items'][number]): HTMLElement {
  // Anchor when we have a link, so the row is genuinely clickable.
  const row = document.createElement(item.url ? 'a' : 'div')
  row.className = `up-row u-${urgencyOf(item.due)}${item.submitted ? ' done' : ''}`
  if (item.url && row instanceof HTMLAnchorElement) {
    row.href = item.url
    row.target = '_blank'
    row.rel = 'noreferrer'
  }

  const chip = document.createElement('span')
  chip.className = 'chip'
  chip.style.background = courseColor(item.courseId)

  const main = document.createElement('span')
  main.className = 'up-main'
  const title = document.createElement('span')
  title.className = 'up-title'
  title.textContent = item.title
  const course = document.createElement('span')
  course.className = 'up-course'
  course.textContent = item.course
  main.append(title, course)
  row.append(chip)

  const when = document.createElement('span')
  when.className = 'up-when'
  const rel = document.createElement('span')
  rel.className = 'up-rel'
  // "in 4h" answers the actual question; the clock time is the detail.
  rel.textContent = relativeTime(item.due)
  const abs = document.createElement('span')
  abs.className = 'up-abs'
  abs.textContent = timeOf(item.due)
  when.append(rel, abs)

  row.append(main, when)
  if (item.submitted) {
    const check = document.createElement('span')
    check.className = 'up-check'
    check.textContent = '\u2713'
    row.append(check)
  }
  return row
}

/** Offers a one-click load when courses are selected but nothing is cached. */
function showEmptyPrompt(): void {
  els.upcoming.replaceChildren()
  const p = document.createElement('p')
  p.className = 'muted'
  p.textContent = 'No deadlines loaded yet.'
  const btn = document.createElement('button')
  btn.className = 'sweep load-btn'
  btn.textContent = 'Load deadlines'
  btn.addEventListener('click', () => void refreshDeadlinesOnly())
  els.upcoming.append(p, btn)
}

function renderUpcoming(): void {
  els.upcoming.replaceChildren()
  els.toggleSubmitted.textContent = hideSubmitted ? 'Show done' : 'Hide done'

  if (cachedDeadlines.length === 0) {
    const p = document.createElement('p')
    p.className = 'muted'
    p.textContent = 'No deadlines cached yet. Hit Refresh below.'
    els.upcoming.append(p)
    return
  }

  const view = buildUpcoming(cachedDeadlines, { hideSubmitted })
  if (view.groups.length === 0) {
    const p = document.createElement('p')
    p.className = 'muted'
    p.textContent = 'Nothing due in the next two weeks.'
    els.upcoming.append(p)
    return
  }

  for (const g of view.groups) {
    const wrap = document.createElement('div')
    wrap.className = `up-group${g.label === 'Overdue' ? ' overdue' : ''}`
    const label = document.createElement('p')
    label.className = 'up-label'
    label.textContent = g.label
    wrap.append(label)
    for (const item of g.items) wrap.append(upcomingRow(item))
    els.upcoming.append(wrap)
  }

  if (view.hiddenCount > 0) {
    const more = document.createElement('p')
    more.className = 'up-more'
    more.textContent = `+${view.hiddenCount} more in the next two weeks`
    els.upcoming.append(more)
  }
}

function courseRow(c: Course, checked: boolean): HTMLLabelElement {
  const label = document.createElement('label')
  label.className = 'course'

  const cb = document.createElement('input')
  cb.type = 'checkbox'
  cb.value = c.id
  cb.checked = checked
  cb.addEventListener('change', () => void onToggle())

  const chip = document.createElement('span')
  chip.className = 'chip'
  chip.style.background = courseColor(c.id)

  const text = document.createElement('span')
  text.className = 'course-text'
  const name = document.createElement('span')
  name.className = 'course-name'
  name.textContent = c.shortName
  const sub = document.createElement('span')
  sub.className = 'course-sub'
  // The term is already the group heading, so don't repeat it here.
  sub.textContent = c.name !== c.shortName ? c.name : ''
  text.append(name, sub)

  label.append(cb, chip, text)
  return label
}

function groupSection(g: CourseGroup, selected: string[]): HTMLDivElement {
  const wrap = document.createElement('div')
  wrap.className = 'term-group'

  const hdr = document.createElement('div')
  hdr.className = 'term-hdr'
  const title = document.createElement('span')
  title.textContent = g.term

  const toggle = document.createElement('button')
  toggle.className = 'link-btn'
  toggle.textContent = 'all'
  hdr.append(title, toggle)
  wrap.append(hdr)

  for (const c of g.courses) wrap.append(courseRow(c, selected.includes(c.id)))

  // One button that selects the whole term, or clears it if already complete.
  toggle.addEventListener('click', () => {
    const boxes = [...wrap.querySelectorAll<HTMLInputElement>('input[type=checkbox]')]
    const next = !boxes.every((b) => b.checked)
    for (const b of boxes) b.checked = next
    void onToggle()
  })

  return wrap
}

function renderCourses(courses: Course[], selected: string[]): void {
  els.courses.replaceChildren()
  if (courses.length === 0) {
    els.coursesEmpty.textContent = 'No courses found. Open Gradescope, sign in, then hit Refresh.'
    els.courses.append(els.coursesEmpty)
    return
  }

  const groups = groupCoursesByTerm(courses)
  for (const g of groups.filter((x) => x.isRecent)) {
    els.courses.append(groupSection(g, selected))
  }

  // Past terms are collapsed, the way Gradescope hides older courses. They stay
  // in the DOM so selectedIds() still reports anything already enabled.
  const older = groups.filter((x) => !x.isRecent)
  if (older.length > 0) {
    const n = older.reduce((acc, g) => acc + g.courses.length, 0)
    const details = document.createElement('details')
    const summary = document.createElement('summary')
    summary.textContent = `Show ${n} older course${n === 1 ? '' : 's'}`
    details.append(summary)
    for (const g of older) details.append(groupSection(g, selected))
    // Opened automatically if an older course is already being synced.
    if (older.some((g) => g.courses.some((c) => selected.includes(c.id)))) details.open = true
    els.courses.append(details)
  }
}

function setAll(checked: boolean): void {
  for (const b of els.courses.querySelectorAll<HTMLInputElement>('input[type=checkbox]')) {
    b.checked = checked
  }
  void onToggle()
}

function selectedIds(): string[] {
  return [...els.courses.querySelectorAll<HTMLInputElement>('input:checked')].map((i) => i.value)
}

async function onToggle(): Promise<void> {
  await saveSettings({ selectedCourseIds: selectedIds() })
  setStatus('Course selection saved.')
}

function describe(report: SyncReport): string {
  if (!report.ok) return report.error ?? 'Last sync failed.'
  const bits = [
    report.created ? `${report.created} added` : '',
    report.updated ? `${report.updated} updated` : '',
    report.deleted ? `${report.deleted} removed` : '',
    report.failed ? `${report.failed} failed` : '',
  ].filter(Boolean)
  const when = new Date(report.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return bits.length > 0 ? `${bits.join(', ')} · ${when}` : `Already up to date · ${when}`
}

function busy(on: boolean, label?: string): void {
  for (const b of [els.sync, els.ics, els.refresh]) b.disabled = on
  // Sync stays unavailable without OAuth, regardless of busy state.
  if (!on && !isOAuthConfigured()) els.sync.disabled = true

  // Clearing here rather than relying on each caller to call setStatus()
  // afterwards: any path that forgot left the loader running forever.
  if (!on) {
    if (els.status.classList.contains('busy')) setStatus('')
    return
  }

  if (label) {
    els.status.replaceChildren()
    const loader = document.createElement('span')
    loader.className = 'loader'
    // Three blocks, then three shadows: the CSS pairs them by nth-child.
    for (let i = 0; i < 3; i++) loader.append(document.createElement('i'))
    for (let i = 0; i < 3; i++) loader.append(document.createElement('b'))

    const text = document.createElement('span')
    text.className = 'status-label'
    text.textContent = label

    els.status.append(loader, text)
    els.status.className = 'status muted busy'
  }
}

async function init(): Promise<void> {
  const [settings, cached, report, connected, deadlines] = await Promise.all([
    loadSettings(),
    loadCourseCache(),
    loadReport(),
    isGoogleConnected(),
    loadAssignmentCache(),
  ])

  cachedDeadlines = deadlines.items
  paintThemeButton(settings.theme)
  renderUpcoming()
  // Nothing to show yet means the user still has setup to do; lead with courses.
  els.coursesCard.hidden = deadlines.items.length > 0 && settings.selectedCourseIds.length > 0

  const oauthReady = isOAuthConfigured()
  els.connect.hidden = connected || !oauthReady
  if (!oauthReady) {
    els.sync.disabled = true
    els.sync.title = 'Needs a Google OAuth client ID (see README)'
    showBanner('Calendar sync is not set up in this build. <b>Download .ics</b> works now.', 'warn')
  }
  renderCourses(cached, settings.selectedCourseIds)
  if (report) setStatus(describe(report), report.ok ? 'ok' : 'err')

  // Cached list renders instantly; only fetch when we have nothing at all.
  if (cached.length === 0) {
    void refreshCourses(true)
  } else if (deadlines.items.length === 0 && settings.selectedCourseIds.length > 0) {
    // Courses are picked but no deadlines are cached. Prompt rather than
    // auto-scraping: opening the popup repeatedly used to restart the scrape
    // every time, which read as the UI being permanently stuck loading.
    showEmptyPrompt()
  }
}

async function refreshCourses(quiet = false): Promise<void> {
  busy(true, 'Reading your Gradescope courses…')
  try {
    const { courses } = await send<{ courses: Course[] }>({ type: 'REFRESH_COURSES' })
    const settings = await loadSettings()
    renderCourses(courses, settings.selectedCourseIds)

    // Deadlines too, so the dashboard fills in without needing Google.
    const { count } = await send<{ count: number }>({ type: 'REFRESH_DEADLINES' })
    cachedDeadlines = (await loadAssignmentCache()).items
    renderUpcoming()

    hideBanner()
    setStatus(`${courses.length} course${courses.length === 1 ? '' : 's'}, ${count} deadline${count === 1 ? '' : 's'}.`)
  } catch (err) {
    if (!quiet || err instanceof Error) explain(err as Error)
    setStatus('Could not load courses.', 'err')
  } finally {
    busy(false)
  }
}

/** Fills the dashboard without re-listing courses. */
async function refreshDeadlinesOnly(): Promise<void> {
  busy(true, 'Loading deadlines\u2026')
  try {
    await send({ type: 'REFRESH_DEADLINES' })
    cachedDeadlines = (await loadAssignmentCache()).items
    renderUpcoming()
    setStatus('')
  } catch (err) {
    explain(err as Error)
  } finally {
    busy(false)
  }
}

els.refresh.addEventListener('click', () => void refreshCourses())
els.toggleSubmitted.addEventListener('click', () => {
  hideSubmitted = !hideSubmitted
  renderUpcoming()
})
els.toggleCourses.addEventListener('click', () => {
  els.coursesCard.hidden = !els.coursesCard.hidden
})
els.selAll.addEventListener('click', () => setAll(true))
els.selNone.addEventListener('click', () => setAll(false))

const THEMES = ['auto', 'light', 'dark'] as const
const THEME_GLYPH = { auto: '\u25D0', light: '\u2600', dark: '\u263D' } as const

function paintThemeButton(t: (typeof THEMES)[number]): void {
  els.themeBtn.textContent = THEME_GLYPH[t]
  els.themeBtn.title = `Theme: ${t}`
}

els.themeBtn.addEventListener('click', () => {
  void (async () => {
    const current = (await loadSettings()).theme
    const next = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length]!
    applyTheme(next)
    paintThemeButton(next)
    await saveSettings({ theme: next })
  })()
})

els.settings.addEventListener('click', () => void chrome.runtime.openOptionsPage())

els.connectBtn.addEventListener('click', () => {
  void (async () => {
    busy(true, 'Waiting for Google…')
    try {
      await send({ type: 'CONNECT_GOOGLE' })
      els.connect.hidden = true
      hideBanner()
      setStatus('Google Calendar connected.', 'ok')
    } catch (err) {
      explain(err as Error)
    } finally {
      busy(false)
    }
  })()
})

els.sync.addEventListener('click', () => {
  void (async () => {
    busy(true, 'Syncing…')
    hideBanner()
    try {
      const { report } = await send<SyncNowData>({ type: 'SYNC_NOW' })
      cachedDeadlines = (await loadAssignmentCache()).items
      renderUpcoming()
      setStatus(describe(report), report.ok ? 'ok' : 'err')
      if (!report.ok && report.error) {
        showBanner(report.error, 'err')
      } else if (report.warnings.length > 0) {
        showBanner(`${report.warnings.length} item(s) skipped. See Settings for details.`, 'warn')
      }
    } catch (err) {
      explain(err as Error)
      setStatus('Sync failed.', 'err')
    } finally {
      busy(false)
    }
  })()
})

els.ics.addEventListener('click', () => {
  void (async () => {
    busy(true, 'Building calendar file…')
    try {
      const { ics, filename, count } = await send<{ ics: string; filename: string; count: number }>({
        type: 'EXPORT_ICS',
      })
      // Popups have Blob URL support; service workers do not, so download here.
      const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }))
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
      setStatus(`Exported ${count} assignment${count === 1 ? '' : 's'}.`, 'ok')
    } catch (err) {
      explain(err as Error)
    } finally {
      busy(false)
    }
  })()
})

void initTheme().then(init)
