import { describe, expect, it } from 'vitest'
import { courseCalendarColorId, courseColor, courseHue } from '../src/lib/colors'

describe('courseColor', () => {
  it('is stable for the same course', () => {
    expect(courseColor('100')).toBe(courseColor('100'))
  })

  it('differs across courses', () => {
    const ids = ['100', '101', '102', '103', '104']
    expect(new Set(ids.map(courseColor)).size).toBeGreaterThan(1)
  })

  it('returns a parseable hsl colour', () => {
    expect(courseColor('100')).toMatch(/^hsl\(\d+ \d+% \d+%\)$/)
  })

  // Red is reserved for overdue work; a course chip must never claim it.
  it('never lands on urgency red', () => {
    for (let i = 0; i < 500; i++) {
      expect(courseHue(String(i))).toBeGreaterThan(20)
    }
  })

  it('spreads a realistic course load across several hues', () => {
    const hues = ['100', '101', '090', '204', '311'].map(courseHue)
    expect(new Set(hues).size).toBeGreaterThanOrEqual(3)
  })
})

describe('courseCalendarColorId', () => {
  it('maps every hue to a valid Google Calendar colour id', () => {
    for (let i = 0; i < 200; i++) {
      const id = Number(courseCalendarColorId(String(i)))
      expect(id).toBeGreaterThanOrEqual(1)
      expect(id).toBeLessThanOrEqual(11)
    }
  })

  it('is stable for the same course', () => {
    expect(courseCalendarColorId('100')).toBe(courseCalendarColorId('100'))
  })
})
