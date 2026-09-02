/**
 * Deterministic per-course colour, so the same course always looks the same
 * without storing an assignment.
 *
 * Hues are picked from a curated ring rather than straight from the hash: a raw
 * hash spreads into yellows and muddy greens that read badly as small chips,
 * and can land on the reds reserved for urgency.
 */

/** Curated, evenly-legible hues. Deliberately excludes 0-20 (urgency red). */
const HUES = [199, 172, 262, 320, 28, 145, 224, 288, 45, 186]

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export function courseHue(courseId: string): number {
  return HUES[hash(courseId) % HUES.length]!
}

/** Chip colour. Saturation and lightness are fixed so chips read as a set. */
export function courseColor(courseId: string): string {
  return `hsl(${courseHue(courseId)} 62% 52%)`
}

/**
 * Google Calendar `colorId`, for when events are coloured per course.
 * Calendar only offers 11 event colours, so this maps our hue onto the nearest.
 */
const GCAL_COLOR_BY_HUE: Record<number, string> = {
  199: '7',  // peacock
  172: '2',  // sage
  262: '3',  // grape
  320: '4',  // flamingo
  28: '6',   // tangerine
  145: '10', // basil
  224: '9',  // blueberry
  288: '3',  // grape
  45: '5',   // banana
  186: '7',  // peacock
}

export function courseCalendarColorId(courseId: string): string {
  return GCAL_COLOR_BY_HUE[courseHue(courseId)] ?? '7'
}
