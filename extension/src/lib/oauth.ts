/**
 * Whether this build has a real Google OAuth client configured.
 *
 * A source checkout ships a placeholder client_id, so Calendar sync cannot work
 * until the developer sets one. Knowing this up front lets the UI disable those
 * controls instead of letting the user click into a Google error.
 */
export function oauthClientId(): string {
  const m = chrome.runtime.getManifest() as { oauth2?: { client_id?: string } }
  return m.oauth2?.client_id ?? ''
}

export function isOAuthConfigured(): boolean {
  const id = oauthClientId()
  return id.length > 0 && !id.startsWith('REPLACE_WITH')
}

/** Shown wherever Calendar sync is unavailable; phrased per surface. */
export const OAUTH_SETUP_HINT =
  'Calendar sync needs a Google OAuth client ID, which this build does not have yet. ' +
  'See “Google OAuth client” in the README.'
