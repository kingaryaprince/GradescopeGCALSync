import { resolve } from 'node:path'
import { copyFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

const src = resolve(__dirname, 'src')
const out = resolve(__dirname, 'dist')

/**
 * Copies files that Chrome loads directly (never imported by JS, so Vite would
 * otherwise not emit them): the manifest and the icon set.
 */
function copyStatic() {
  return {
    name: 'copy-static',
    closeBundle() {
      copyFileSync(resolve(src, 'manifest.json'), resolve(out, 'manifest.json'))
      const icons = resolve(src, 'icons')
      if (existsSync(icons)) {
        mkdirSync(resolve(out, 'icons'), { recursive: true })
        for (const f of readdirSync(icons)) {
          copyFileSync(resolve(icons, f), resolve(out, 'icons', f))
        }
      }
    },
  }
}

export default defineConfig({
  // root=src keeps HTML entries at dist/popup/index.html rather than
  // dist/src/popup/index.html, so manifest paths stay clean.
  root: src,
  resolve: { alias: { '@': src } },
  plugins: [copyStatic()],
  build: {
    outDir: out,
    emptyOutDir: true,
    // MV3 rejects inlined assets referenced via data: URIs under a strict CSP.
    assetsInlineLimit: 0,
    modulePreload: false,
    target: 'chrome114',
    rollupOptions: {
      input: {
        background: resolve(src, 'background.ts'),
        popup: resolve(src, 'popup/index.html'),
        offscreen: resolve(src, 'offscreen.html'),
        options: resolve(src, 'options/index.html'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    root: __dirname,
    include: ['tests/**/*.test.ts'],
  },
})
