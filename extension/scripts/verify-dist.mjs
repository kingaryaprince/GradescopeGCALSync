/**
 * Fails the build if the manifest points at a file that was not emitted.
 * A missing offscreen.html or background.js only surfaces at runtime otherwise,
 * usually as a silent no-op.
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const manifest = JSON.parse(readFileSync(resolve(dist, 'manifest.json'), 'utf8'))

const refs = new Set()
const add = (p) => { if (typeof p === 'string' && !/^https?:/.test(p)) refs.add(p) }

add(manifest.background?.service_worker)
add(manifest.action?.default_popup)
add(manifest.options_page)
Object.values(manifest.icons ?? {}).forEach(add)
Object.values(manifest.action?.default_icon ?? {}).forEach(add)
for (const cs of manifest.content_scripts ?? []) (cs.js ?? []).forEach(add)
// Not referenced by the manifest itself, but created at runtime by background.js.
add('offscreen.html')

const missing = [...refs].filter((r) => !existsSync(resolve(dist, r)))

if (missing.length > 0) {
  console.error('\nBuild is missing files referenced by the extension:')
  for (const m of missing) console.error(`  - ${m}`)
  process.exit(1)
}

const clientId = manifest.oauth2?.client_id ?? ''
if (clientId.startsWith('REPLACE_WITH')) {
  console.warn('\n  Note: oauth2.client_id is still a placeholder.')
  console.warn('  Google Calendar sync will not work until you set it (see README).')
  console.warn('  The .ics export works regardless.\n')
}

console.log(`Verified ${refs.size} manifest references.`)
