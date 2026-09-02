import { fetchAssignments, fetchCourses } from './lib/gradescope/client'
import { toWire, ok, fail, type Request, type Response } from './lib/messages'

/**
 * Runs Gradescope fetching and HTML parsing.
 *
 * Lives in an offscreen document because MV3 service workers have no DOMParser,
 * and because an extension-origin fetch still carries the user's Gradescope
 * session cookie (it is SameSite=None), so no password or visible tab is needed.
 */
chrome.runtime.onMessage.addListener(
  (msg: Request & { target?: string }, _sender, sendResponse: (r: Response) => void) => {
    if (msg.target !== 'offscreen') return false

    void (async () => {
      try {
        switch (msg.type) {
          case 'SCRAPE_COURSES': {
            const r = await fetchCourses()
            sendResponse(ok({ courses: r.items, strategy: r.strategy, warnings: r.warnings }))
            break
          }
          case 'SCRAPE_ASSIGNMENTS': {
            const r = await fetchAssignments(msg.course)
            sendResponse(
              ok({ assignments: r.items.map(toWire), strategy: r.strategy, warnings: r.warnings }),
            )
            break
          }
          default:
            sendResponse(fail(new Error(`Offscreen cannot handle ${msg.type}`)))
        }
      } catch (err) {
        sendResponse(fail(err))
      }
    })()

    // Keep the message channel open for the async work above.
    return true
  },
)
