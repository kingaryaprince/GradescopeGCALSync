import { loadSettings } from './storage'
import type { SyncSettings } from './types'

/**
 * Applies the theme by setting `data-theme` on <html>. The token stylesheet
 * treats an explicit value as an override of `prefers-color-scheme`.
 */
export function applyTheme(theme: SyncSettings['theme']): void {
  document.documentElement.dataset['theme'] = theme
}

/**
 * Applied before first paint to avoid a flash of the wrong theme, and kept in
 * step afterwards so a change in one surface shows up in the other.
 */
export async function initTheme(): Promise<void> {
  applyTheme((await loadSettings()).theme)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes['settings']) return
    const next = changes['settings'].newValue as SyncSettings | undefined
    if (next?.theme) applyTheme(next.theme)
  })
}
