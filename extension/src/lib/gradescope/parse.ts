import type { Assignment, Course, ParseResult } from '../types'
import { looksLikeDueDate, parseDueDate } from './dates'

/**
 * Gradescope has no public API and ships no stable markup contract, so parsing
 * is layered: a `semantic` pass reads the class names Gradescope currently uses,
 * and a `structural` pass falls back to reading the assignment table by its
 * column headers. The reported strategy tells us which one fired, which is what
 * makes selector breakage diagnosable instead of silent.
 */

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/**
 * Stable de-duplication key. Excludes the due date on purpose: keying on the
 * date meant a rescheduled deadline looked like a brand-new assignment and
 * produced a duplicate event instead of updating the existing one.
 */
export function assignmentKey(courseId: string, assignmentId: string | undefined, title: string): string {
  const tail = assignmentId ? `a${assignmentId}` : `t-${slugify(title)}`
  return `gsync:v1:c${courseId}:${tail}`
}

const TERM_RE = /\b(spring|summer|fall|autumn|winter)\s*'?\d{2,4}\b/i

function text(el: Element | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function courseIdFromHref(href: string): string | null {
  return /\/courses\/(\d+)/.exec(href)?.[1] ?? null
}

function assignmentIdFromHref(href: string): string | undefined {
  return /\/assignments\/(\d+)/.exec(href)?.[1]
}

/** Pulls an ISO timestamp out of the attributes Gradescope might expose. */
function exactDateFrom(el: Element | null): string | null {
  if (!el) return null
  for (const attr of ['datetime', 'data-due-date', 'data-timestamp', 'title', 'aria-label']) {
    const v = el.getAttribute(attr)
    if (v && /\d{4}-\d{2}-\d{2}/.test(v)) return v
  }
  const t = el.querySelector('time[datetime]')
  return t?.getAttribute('datetime') ?? null
}


const SCORE_RE = /(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/

export interface SubmissionInfo {
  status?: string
  score?: { earned: number; total: number }
  submitted: boolean
}

/**
 * Reads the submission status cell, which Gradescope renders as free text
 * ("Submitted", "No Submission") or as a score ("18.0 / 20.0").
 */
export function readSubmission(cell: Element | undefined): SubmissionInfo {
  const raw = text(cell)
  if (!raw) return { submitted: false }

  const m = SCORE_RE.exec(raw)
  const score = m ? { earned: Number.parseFloat(m[1]!), total: Number.parseFloat(m[2]!) } : undefined

  // "No Submission" contains "Submission", so the negative must be tested first.
  const submitted = /no submission|not submitted/i.test(raw)
    ? false
    : score !== undefined || /submitted|graded|complete/i.test(raw)

  return { ...(raw ? { status: raw } : {}), ...(score ? { score } : {}), submitted }
}

// ------------------------------- courses -------------------------------

/**
 * Parses the dashboard (/account) into the user's courses.
 * Terms are attached by finding the nearest preceding term heading in document
 * order, which survives renames of the heading's class.
 */
export function parseCourses(doc: Document): ParseResult<Course> {
  const warnings: string[] = []
  const seen = new Map<string, Course>()

  const anchors = Array.from(doc.querySelectorAll<HTMLAnchorElement>('a[href*="/courses/"]'))
  let strategy: 'semantic' | 'structural' | 'none' = 'none'

  // Map each element that looks like a term heading to its document position so
  // we can assign each course the term it appears under.
  const walker = doc.createTreeWalker(doc.body ?? doc, 1 /* SHOW_ELEMENT */)
  const order: Element[] = []
  for (let n = walker.currentNode as Element | null; n; n = walker.nextNode() as Element | null) {
    order.push(n)
  }
  const termAt = new Map<number, string>()
  order.forEach((el, i) => {
    // Only consider leaf-ish headings so we don't match a whole container's text.
    if (el.children.length === 0) {
      const t = text(el)
      if (t.length <= 40 && TERM_RE.test(t)) termAt.set(i, TERM_RE.exec(t)![0])
    }
  })

  const termForIndex = (idx: number): string | undefined => {
    let best: string | undefined
    for (const [i, t] of termAt) if (i <= idx) best = t
    return best
  }

  for (const a of anchors) {
    const href = a.getAttribute('href') ?? ''
    const id = courseIdFromHref(href)
    // Skip deep links (assignments, submissions); we only want course roots.
    if (!id || /\/courses\/\d+\/.+/.test(href)) continue
    if (seen.has(id)) continue

    const isCourseBox = a.className.includes('courseBox')
    if (isCourseBox) strategy = 'semantic'
    else if (strategy === 'none') strategy = 'structural'

    const shortName =
      text(a.querySelector('.courseBox--shortname')) ||
      text(a.querySelector('h3,h4')) ||
      text(a)
    const name = text(a.querySelector('.courseBox--name')) || shortName
    if (!shortName) {
      warnings.push(`Course ${id}: no readable name, skipped.`)
      continue
    }

    const idx = order.indexOf(a)
    const term = text(a.querySelector('.courseBox--term')) || termForIndex(idx)

    seen.set(id, {
      id,
      shortName,
      name,
      ...(term ? { term } : {}),
      url: new URL(href, 'https://www.gradescope.com').toString(),
    })
  }

  if (seen.size === 0) warnings.push('No courses found on the dashboard.')
  return { items: [...seen.values()], strategy, warnings }
}

// ----------------------------- assignments -----------------------------

interface ColumnMap {
  due?: number
  name?: number
  status?: number
}

/** Reads the table header so we select the Due column by meaning, not position. */
function columnMap(table: Element): ColumnMap {
  const head = table.querySelector('thead tr')
  if (!head) return {}
  const cells = Array.from(head.querySelectorAll('th,td'))
  const map: ColumnMap = {}
  cells.forEach((c, i) => {
    const t = text(c).toLowerCase()
    // "Late Due" must not win the Due slot.
    if (map.due === undefined && /\bdue\b/.test(t) && !t.includes('late')) map.due = i
    if (map.name === undefined && /(name|assignment)/.test(t)) map.name = i
    if (map.status === undefined && /(status|score|grade)/.test(t)) map.status = i
  })
  return map
}

/**
 * Splits a cell into candidate date lines, dropping Gradescope's decorations
 * ("2 days left") and any explicitly late deadline.
 */
function dateLinesFrom(cell: Element | undefined): { due: string[]; late: string[] } {
  const due: string[] = []
  const late: string[] = []
  if (!cell) return { due, late }

  // Prefer per-element reads so aria-labels can distinguish due from late due.
  const parts = Array.from(cell.querySelectorAll('*')).filter((e) => e.children.length === 0)
  const sources: Element[] = parts.length > 0 ? parts : [cell]

  for (const el of sources) {
    const label = `${el.getAttribute('aria-label') ?? ''} ${el.className ?? ''}`.toLowerCase()
    const raw = exactDateFrom(el) ?? text(el)
    if (!raw || !looksLikeDueDate(raw)) continue
    if (/release/.test(label)) continue
    if (/late/.test(label) || /late due/i.test(text(el))) {
      late.push(raw)
      continue
    }
    due.push(raw)
  }

  if (due.length === 0 && late.length === 0) {
    for (const ln of text(cell).split(/\n|(?=[A-Z][a-z]{2}\s+\d)/)) {
      const s = ln.trim()
      if (!s || /left\b/i.test(s)) continue
      if (looksLikeDueDate(s)) (/late/i.test(s) ? late : due).push(s)
    }
  }
  return { due, late }
}

export function parseAssignments(
  doc: Document,
  courseId: string,
  opts: { term?: string; now?: Date } = {},
): ParseResult<Assignment> {
  const warnings: string[] = []
  const items: Assignment[] = []
  let strategy: 'semantic' | 'structural' | 'none' = 'none'

  const tables = Array.from(doc.querySelectorAll('table'))
  if (tables.length === 0) {
    return { items, strategy: 'none', warnings: ['No assignment table found on the course page.'] }
  }

  for (const table of tables) {
    const cols = columnMap(table)
    const rows = Array.from(table.querySelectorAll('tbody tr'))

    for (const row of rows) {
      // th carries the assignment name in Gradescope's student table, so include
      // it. Filtering children beats ':scope >' here: same direct-child
      // semantics, and it does not depend on :scope support.
      const cells = Array.from(row.children).filter(
        (c) => c.tagName === 'TD' || c.tagName === 'TH',
      )
      if (cells.length === 0) continue

      const link =
        row.querySelector<HTMLAnchorElement>('th.table--primaryLink a[href], a[href*="/assignments/"]') ??
        row.querySelector<HTMLAnchorElement>('a[href]')

      const nameCell = cols.name !== undefined ? cells[cols.name] : cells[0]
      const title = text(link) || text(nameCell)
      if (!title) continue
      // Skip nested header/group rows that carry no data.
      if (cells.length === 1 && !link) continue

      const href = link?.getAttribute('href') ?? undefined
      const assignmentId = href ? assignmentIdFromHref(href) : undefined
      if (row.querySelector('.submissionTimeChart--dueDate') || row.querySelector('th.table--primaryLink')) {
        strategy = 'semantic'
      } else if (strategy === 'none') {
        strategy = 'structural'
      }

      // Semantic due cell first, then the header-mapped column, then whole row.
      const semanticCell = row.querySelector('.submissionTimeChart')
      const dueCell =
        semanticCell ??
        (cols.due !== undefined ? cells[cols.due] : undefined) ??
        cells[cells.length - 1]

      let { due: dueTexts, late: lateTexts } = dateLinesFrom(dueCell)

      // Some layouts scatter the dates across cells; widen the search once.
      if (dueTexts.length === 0) {
        const all = dateLinesFrom(row)
        dueTexts = all.due
        lateTexts = all.late
      }

      // With two unlabeled deadlines, the earlier one is the real due date.
      if (dueTexts.length > 1) {
        const parsed = dueTexts
          .map((t) => ({ t, d: parseDueDate(t, opts) }))
          .filter((x): x is { t: string; d: Date } => x.d !== null)
          .sort((a, b) => a.d.getTime() - b.d.getTime())
        if (parsed.length > 1) {
          lateTexts = [...parsed.slice(1).map((p) => p.t), ...lateTexts]
          dueTexts = [parsed[0]!.t]
        }
      }

      const dueRaw = dueTexts[0] ?? ''
      if (!dueRaw) {
        warnings.push(`"${title}": no due date found, skipped.`)
        continue
      }

      const due = parseDueDate(dueRaw, opts)
      if (!due) {
        warnings.push(`"${title}": could not read due date "${dueRaw}", skipped.`)
        continue
      }

      const statusCell =
        row.querySelector('.submissionStatus') ??
        (cols.status !== undefined ? cells[cols.status] : undefined)
      const submission = readSubmission(statusCell ?? undefined)

      const lateRaw = lateTexts[0]
      items.push({
        key: assignmentKey(courseId, assignmentId, title),
        courseId,
        ...(assignmentId ? { assignmentId } : {}),
        title,
        due,
        dueRaw,
        ...(lateRaw ? { lateDue: parseDueDate(lateRaw, opts) } : {}),
        ...(href ? { url: new URL(href, 'https://www.gradescope.com').toString() } : {}),
        dueIsExact: /\d{4}-\d{2}-\d{2}/.test(dueRaw),
        ...submission,
      })
    }
  }

  // Same assignment can appear in more than one table; keep the first.
  const unique = new Map<string, Assignment>()
  for (const a of items) if (!unique.has(a.key)) unique.set(a.key, a)

  if (unique.size === 0 && warnings.length === 0) {
    warnings.push('Found the table but no assignment rows were readable.')
  }
  return { items: [...unique.values()], strategy, warnings }
}
