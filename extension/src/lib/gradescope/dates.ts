/**
 * Gradescope renders due dates without a year ("Oct 04 at 4:00PM"), so the year
 * has to be inferred. The original script assumed the current calendar year,
 * which silently broke every winter: in December, a spring assignment due
 * "Jan 15" resolved to eleven months in the past.
 *
 * We infer instead, preferring the course's term window when we know it and
 * otherwise choosing the candidate year closest to now.
 */

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
}

/** Matches "Oct 04 at 4:00PM", "October 4, 2025 at 11:59 PM", "Oct 4". */
const DUE_RE = new RegExp(
  '([A-Za-z]{3,9})\\s+(\\d{1,2})' +       // month name + day
  '(?:\\s*,?\\s*(\\d{4}))?' +             // optional explicit year
  '(?:\\s*(?:at|@)?\\s*' +                // optional "at"
  '(\\d{1,2}):(\\d{2})\\s*([AaPp])\\.?[Mm]\\.?' + // 12-hour time
  ')?',
)

/** Matches an ISO-8601 timestamp, as found in datetime="" attributes. */
const ISO_RE = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/

export interface TermWindow {
  start: Date
  end: Date
}

/**
 * Approximate calendar window for a term label like "Fall 2025".
 * Windows are intentionally generous; they only need to disambiguate years.
 */
export function termWindow(term: string | undefined): TermWindow | null {
  if (!term) return null
  const m = /(spring|summer|fall|autumn|winter)\s*'?(\d{2,4})/i.exec(term)
  if (!m) return null

  const season = m[1]!.toLowerCase()
  let year = parseInt(m[2]!, 10)
  if (year < 100) year += 2000

  switch (season) {
    case 'spring':
      return { start: new Date(year, 0, 1), end: new Date(year, 5, 30) }
    case 'summer':
      return { start: new Date(year, 4, 1), end: new Date(year, 8, 15) }
    case 'fall':
    case 'autumn':
      // Fall terms routinely spill into January for finals and late deadlines.
      return { start: new Date(year, 7, 1), end: new Date(year + 1, 0, 31) }
    case 'winter':
      return { start: new Date(year - 1, 11, 1), end: new Date(year, 3, 30) }
    default:
      return null
  }
}

/** True when y/m/d survives a round trip, rejecting things like Feb 29 in 2025. */
function isRealDate(y: number, month: number, day: number): boolean {
  const d = new Date(y, month, day)
  return d.getFullYear() === y && d.getMonth() === month && d.getDate() === day
}

export interface ResolveOptions {
  now?: Date
  term?: string
}

/**
 * Parses Gradescope due-date text into a local-timezone Date.
 *
 * Runs in the user's browser, so the browser's timezone is the right one and no
 * manual timezone configuration is needed.
 *
 * @returns the resolved Date, or null when the text has no recognizable date.
 */
export function parseDueDate(raw: string, opts: ResolveOptions = {}): Date | null {
  if (!raw) return null
  const now = opts.now ?? new Date()

  // An explicit ISO timestamp is unambiguous; never guess when we have one.
  const iso = ISO_RE.exec(raw)
  if (iso) {
    const d = new Date(iso[0].replace(' ', 'T'))
    if (!Number.isNaN(d.getTime())) return d
  }

  const m = DUE_RE.exec(raw)
  if (!m) return null

  const month = MONTHS[m[1]!.slice(0, 3).toLowerCase()]
  if (month === undefined) return null
  const day = parseInt(m[2]!, 10)
  if (day < 1 || day > 31) return null

  // Gradescope shows no time for some rows; end-of-day is the safe reading.
  let hour = 23
  let minute = 59
  if (m[4] !== undefined && m[5] !== undefined && m[6] !== undefined) {
    hour = parseInt(m[4], 10) % 12
    if (m[6]!.toLowerCase() === 'p') hour += 12
    minute = parseInt(m[5], 10)
  }

  const build = (y: number): Date | null =>
    isRealDate(y, month, day) ? new Date(y, month, day, hour, minute, 0, 0) : null

  // Explicit year in the text wins outright.
  if (m[3] !== undefined) return build(parseInt(m[3], 10))

  const candidates = [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1]
    .map(build)
    .filter((d): d is Date => d !== null)
  if (candidates.length === 0) return null

  // A known term window is the strongest signal available.
  const win = termWindow(opts.term)
  if (win) {
    const inTerm = candidates.filter((d) => d >= win.start && d <= win.end)
    if (inTerm.length === 1) return inTerm[0]!
    if (inTerm.length > 1) return nearestTo(inTerm, now)
  }

  // Otherwise the nearest candidate to today. This is what makes December
  // correctly resolve "Jan 15" to next January rather than last January.
  return nearestTo(candidates, now)
}

function nearestTo(dates: Date[], now: Date): Date {
  return dates.reduce((best, d) =>
    Math.abs(d.getTime() - now.getTime()) < Math.abs(best.getTime() - now.getTime()) ? d : best,
  )
}

/** True when the string looks like a Gradescope date, used to pick date cells. */
export function looksLikeDueDate(s: string): boolean {
  const t = s.trim()
  if (!t) return false
  if (ISO_RE.test(t)) return true
  const m = DUE_RE.exec(t)
  return m !== null && MONTHS[m[1]!.slice(0, 3).toLowerCase()] !== undefined
}
