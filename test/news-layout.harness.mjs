import assert from 'node:assert/strict'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')

export const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
]

// NEWS_LAYOUT_SHOTS must point OUTSIDE the repository: screenshots are
// generated artefacts and must never be written into the repo. The check is
// a lexical resolve plus a path-relative boundary test, so a repo-relative
// string or traversal cannot land inside the repo, the repo root itself is
// rejected, and a sibling directory whose name merely shares the repo root's
// prefix (e.g. `<root>-sibling`) is not falsely rejected.
export const shotsOutsideRepo = target => {
  const resolved = resolve(String(target))
  const rel = relative(ROOT, resolved)
  const outside = rel !== '' && (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
  assert.ok(outside,
    `NEWS_LAYOUT_SHOTS must not point inside the repository: ${target} (resolved ${resolved})`)
  return resolved
}
