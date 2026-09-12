/**
 * Render check for the browser half's highlighted source.
 *
 * The plugin's only other browser-side check (`scripts/gui-check.mjs`) needs a
 * running GUI and a session token, which is a lot of ceremony to answer "does a
 * token run become the right `<span>`". This script instead loads the built
 * client bundle the way the web shell does — through the module loader — hands it
 * the shared modules through a stub `require`, and renders a page the host half
 * really highlighted with `tinymist`'s own semantic tokens. React's static
 * renderer then shows the exact markup, so the class names, the file text and the
 * line numbers are all asserted against a real document.
 *
 * Run with `node scripts/render-check.mjs` after `pnpm build`.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { TypstHighlighter } from '../lib/dev/host-highlight.js'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const scratch = join(packageRoot, '.tmp-render')
const fixture = join(scratch, 'render.typ')
const require = createRequire(import.meta.url)

let failures = 0
function check(label, ok, detail = '') {
  if (ok) {
    console.log(`  PASS  ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

/* -------------------------------------------------------- the built browser half */

/** What the shell's module table would hand the bundle. */
const shared = {
  '@deepseek-ai/dsh-client-ui-primitives': { CodeBlock: () => null, writeClipboard: async () => true },
}

let defined = null
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      defined = spec
    },
  },
}
await import(pathToFileURL(join(packageRoot, 'lib/client.js')).href)
if (defined === null) throw new Error('the client bundle registered nothing')
const client = defined.factory((id) => (id in shared ? shared[id] : require(id)))

/* ------------------------------------------------------------- a real page of runs */

rmSync(scratch, { recursive: true, force: true })
mkdirSync(scratch, { recursive: true })
writeFileSync(
  fixture,
  [
    '#set text(font: ("New Computer Modern", "Songti SC", "STSong", "SimSun"))',
    '#set page(width: 12cm)',
    '#set heading(numbering: "1.")',
    '= 标题 <title>',
    'Let $x^2 + y^2 = z^2$ and *强调* for @title. // 注释',
  ].join('\n') + '\n',
  'utf8',
)

const highlighter = new TypstHighlighter()
const page = await highlighter.page({ file: fixture, offset: 1, limit: 100 })
await highlighter.dispose()

const html = renderToStaticMarkup(
  client.HighlightedSource({ chunks: [{ offset: page.offset, text: page.text, spans: page.spans }], classes: page.classes }),
)

check(
  'the page rendered one row per line, with line numbers',
  ['>1<', '>2<', '>3<', '>4<'].every((row) => html.includes(row)),
  html.slice(0, 200),
)
check('the rows are the highlighted variant', html.includes('data-typst-code="highlighted"'))
check('the `#set` keyword carries the keyword class', /<span class="dshTypstPreview_t-keyword">#set<\/span>/.test(html))
check('`page` carries the function class', html.includes('>page</span>'))
check('strong markup carries the strong style bit', /<span class="dshTypstPreview_t-punctuation dshTypstPreview_s1">\*<\/span>/.test(html))
check('the trailing comment carries the comment class', html.includes('dshTypstPreview_t-comment">// 注释</span>'))
check('CJK text is escaped into text, not markup', html.includes('标题'))

/** The rendered rows, tags stripped and entities decoded, as plain text. */
const unescape = (text) =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
const rows = [...html.matchAll(/<span class="dshTypstPreview_line">([\s\S]*?)<\/span><\/div>/g)].map((match) =>
  unescape((match[1] ?? '').replace(/<[^>]*>/g, '')),
)
check(
  'every line of the file survives rendering character for character',
  rows.length === page.text.split('\n').length && page.text.split('\n').every((line, index) => rows[index] === line),
  JSON.stringify({ expected: page.text.split('\n'), rows }).slice(0, 260),
)

console.log(failures === 0 ? '\nRENDER OK' : `\nRENDER FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
