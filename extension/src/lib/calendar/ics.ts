import type { Assignment, Course, SyncSettings } from '../types'

/**
 * Minimal RFC 5545 writer. Emits UTC timestamps so no VTIMEZONE component is
 * needed and every calendar client agrees on the instant.
 */

/** Escapes a text value per RFC 5545 section 3.3.11. */
function esc(v: string): string {
  return v
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n')
}

/** Folds long lines to 75 octets, continuing with a leading space. */
function fold(line: string): string {
  const bytes = new TextEncoder().encode(line)
  if (bytes.length <= 75) return line

  const out: string[] = []
  let cur = ''
  let curBytes = 0
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length
    // Continuation lines carry a leading space, so budget one octet less.
    const limit = out.length === 0 ? 75 : 74
    if (curBytes + n > limit) {
      out.push(cur)
      cur = ''
      curBytes = 0
    }
    cur += ch
    curBytes += n
  }
  if (cur) out.push(cur)
  return out.join('\r\n ')
}

/** Formats a Date as a UTC iCalendar timestamp: 20251004T230000Z. */
export function icsDate(d: Date): string {
  return `${d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`
}

export interface IcsOptions {
  calendarName?: string
  durationMinutes?: number
  reminderMinutes?: number[]
  prefixCourse?: boolean
}

export function buildIcs(
  entries: Array<{ assignment: Assignment; course: Course }>,
  opts: IcsOptions = {},
): string {
  const {
    calendarName = 'Gradescope',
    durationMinutes = 30,
    reminderMinutes = [24 * 60],
    prefixCourse = true,
  } = opts

  const stamp = icsDate(new Date())
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Gradescope Calendar Sync//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(calendarName)}`,
  ]

  for (const { assignment, course } of entries) {
    if (!assignment.due) continue
    const end = new Date(assignment.due.getTime() + durationMinutes * 60_000)
    const summary = prefixCourse ? `${course.shortName}: ${assignment.title}` : assignment.title

    const desc = [
      `Gradescope due: ${assignment.dueRaw}`,
      assignment.lateDue ? `Late deadline: ${assignment.lateDue.toLocaleString()}` : '',
      assignment.url ?? '',
    ]
      .filter(Boolean)
      .join('\n')

    lines.push(
      'BEGIN:VEVENT',
      // The stable key doubles as the UID so re-importing updates in place.
      `UID:${esc(assignment.key)}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsDate(assignment.due)}`,
      `DTEND:${icsDate(end)}`,
      `SUMMARY:${esc(summary)}`,
      `DESCRIPTION:${esc(desc)}`,
      ...(assignment.url ? [`URL:${esc(assignment.url)}`] : []),
      'SEQUENCE:0',
      'STATUS:CONFIRMED',
      'TRANSP:TRANSPARENT',
    )
    for (const m of reminderMinutes) {
      lines.push(
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        `DESCRIPTION:${esc(summary)}`,
        `TRIGGER:-PT${m}M`,
        'END:VALARM',
      )
    }
    lines.push('END:VEVENT')
  }

  lines.push('END:VCALENDAR')
  return lines.map(fold).join('\r\n') + '\r\n'
}

export function icsFilename(settings?: Pick<SyncSettings, 'calendarId'>): string {
  void settings
  const d = new Date().toISOString().slice(0, 10)
  return `gradescope-${d}.ics`
}
