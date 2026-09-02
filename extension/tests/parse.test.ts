import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseAssignments, parseCourses, assignmentKey } from '../src/lib/gradescope/parse'

const load = (name: string): Document =>
  new DOMParser().parseFromString(
    readFileSync(resolve(__dirname, 'fixtures', name), 'utf8'),
    'text/html',
  )

const NOW = new Date('2025-10-01T12:00:00')

describe('parseCourses', () => {
  it('reads every course with its term', () => {
    const { items, strategy } = parseCourses(load('dashboard.html'))
    expect(strategy).toBe('semantic')
    expect(items).toHaveLength(3)

    const cs70 = items.find((c) => c.id === '100')!
    expect(cs70.shortName).toBe('CS 70')
    expect(cs70.name).toBe('Discrete Math and Probability Theory')
    expect(cs70.term).toBe('Fall 2025')
    expect(cs70.url).toBe('https://www.gradescope.com/courses/100')
  })

  it('attaches the term heading each course actually sits under', () => {
    const { items } = parseCourses(load('dashboard.html'))
    expect(items.find((c) => c.id === '101')!.term).toBe('Fall 2025')
    expect(items.find((c) => c.id === '090')!.term).toBe('Spring 2025')
  })

  it('ignores deep links into a course', () => {
    const doc = new DOMParser().parseFromString(
      `<a href="/courses/1/assignments/2">x</a><a class="courseBox" href="/courses/1"><h3>C</h3></a>`,
      'text/html',
    )
    const { items } = parseCourses(doc)
    expect(items.map((c) => c.id)).toEqual(['1'])
  })
})

describe('parseAssignments (semantic layout)', () => {
  const run = () => parseAssignments(load('course-semantic.html'), '100', { term: 'Fall 2025', now: NOW })

  it('uses the semantic strategy', () => {
    expect(run().strategy).toBe('semantic')
  })

  it('picks the due date, never the late due date', () => {
    const hw = run().items.find((a) => a.title === 'Homework 5')!
    expect(hw.due!.getDate()).toBe(4)
    expect(hw.due!.getHours()).toBe(16)
    // Oct 06 is the late deadline and must not become the event date.
    expect(hw.lateDue!.getDate()).toBe(6)
  })

  it('ignores the release date', () => {
    const hw = run().items.find((a) => a.title === 'Homework 5')!
    expect(hw.due!.getMonth()).toBe(9)
    expect(hw.due!.getDate()).not.toBe(27)
  })

  it('ignores "2 days left" decoration', () => {
    const att = run().items.find((a) => a.title === 'Attendance Week 6')!
    expect(att.due!.getDate()).toBe(8)
  })

  it('skips rows with no due date and warns', () => {
    const { items, warnings } = run()
    expect(items.map((a) => a.title)).not.toContain('Mini-Vitamin 9')
    expect(warnings.join(' ')).toMatch(/Mini-Vitamin 9/)
  })

  it('extracts the assignment id from a submission URL', () => {
    const hw = run().items.find((a) => a.title === 'Homework 5')!
    expect(hw.assignmentId).toBe('501')
    expect(hw.key).toBe('gsync:v1:c100:a501')
  })
})

describe('parseAssignments (structural fallback)', () => {
  const run = () => parseAssignments(load('course-structural.html'), '200', { now: NOW })

  it('falls back to the structural strategy', () => {
    expect(run().strategy).toBe('structural')
  })

  it('selects the Due column by header, not by position', () => {
    const lab = run().items.find((a) => a.title === 'Lab 3')!
    // Oct 18 is Due; Oct 20 sits in an earlier column and is the late deadline.
    expect(lab.due!.getDate()).toBe(18)
  })

  it('handles rows with no link by keying on the title', () => {
    const quiz = run().items.find((a) => a.title === 'Reading Quiz 2')!
    expect(quiz.assignmentId).toBeUndefined()
    expect(quiz.key).toBe('gsync:v1:c200:t-reading-quiz-2')
  })
})

describe('assignmentKey', () => {
  // The original keyed on the due timestamp, so moving a deadline created a
  // duplicate event instead of updating the existing one.
  it('is stable when the due date changes', () => {
    expect(assignmentKey('100', '501', 'Homework 5')).toBe(assignmentKey('100', '501', 'Homework 5'))
  })

  it('is stable when an assignment is renamed, given an id', () => {
    expect(assignmentKey('100', '501', 'Homework 5')).toBe(assignmentKey('100', '501', 'HW 5 (revised)'))
  })

  it('separates identical titles across courses', () => {
    expect(assignmentKey('100', undefined, 'Homework 5')).not.toBe(assignmentKey('200', undefined, 'Homework 5'))
  })
})
