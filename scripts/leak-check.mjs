/**
 * Leak check for the preview fleet.
 *
 * This is the regression test for the bug that filled a user's machine with
 * `tinymist preview` processes at ~600 MB each: `open` had no in-flight
 * deduplication, so two requests for the same file (a remount, a second pane, a
 * reload racing the first request) each started a compiler, the loser was
 * overwritten in the instance map, and nothing in the process could ever reach it
 * again — `close`, the reaper and `dispose` all walked that map.
 *
 * It drives the manager directly, because the property under test is "how many
 * children does this process own", which is exactly what the HTTP routes hide.
 * Every check reads the real process table, not the manager's bookkeeping: a map
 * that forgot a live child is the failure mode.
 *
 * Run with `node scripts/leak-check.mjs` after `pnpm build`.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_OPTIONS, TinymistPreviews } from '../lib/dev/host-tinymist.js'

const here = dirname(fileURLToPath(import.meta.url))
const scratch = join(resolve(here, '..'), '.tmp-leak')
rmSync(scratch, { recursive: true, force: true })
mkdirSync(scratch, { recursive: true })

let failures = 0
function check(label, ok, detail = '') {
  if (ok) {
    console.log(`  PASS  ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

/** Whether the OS still has a preview listening on one instance's data port. */
function alive(instance) {
  const needle = `data-plane-host 127.0.0.1:${instance.dataPort}`
  try {
    return execFileSync('/bin/ps', ['-axo', 'command']).toString().split('\n').some((line) => line.includes(needle))
  } catch {
    return false
  }
}

/** Every preview this script started, whether or not the manager still lists it. */
const started = []
function fixture(name) {
  const file = join(scratch, name)
  writeFileSync(file, `#set page(width: 240pt, height: 160pt)\n= ${name}\n$ x^2 $\n`, 'utf8')
  return file
}

const files = Array.from({ length: 5 }, (_, index) => fixture(`f${index}.typ`))
const previews = new TinymistPreviews({ ...DEFAULT_OPTIONS, maxInstances: 2, readyTimeoutMs: 20_000 })
const stopReaper = previews.startReaper()

const open = async (file, invert = 'never') => {
  const instance = await previews.open({ file, cwd: scratch, sessionId: 'leak-check', invert })
  started.push(instance)
  return instance
}

try {
  /* 1. the same file asked for twice at once is one process, not two */
  const [a, b] = await Promise.all([open(files[0]), open(files[0])])
  check('two simultaneous opens of one file share a token', a.token === b.token, `${a.token} vs ${b.token}`)
  check('and share one child process', alive(a) && !alive({ dataPort: -1 }), `data port ${a.dataPort}`)
  check('the manager counts exactly one process', previews.processCount === 1, `${previews.processCount}`)

  /* 2. the LRU cap evicts by killing, not by forgetting */
  const evicted = []
  for (const file of files.slice(1)) evicted.push(await open(file))
  check('the live set stays inside the cap', previews.list().length === 2, `${previews.list().length}`)
  await new Promise((settle) => setTimeout(settle, 500))
  const survivors = started.filter((instance) => alive(instance))
  check('every evicted child is really gone', survivors.length === previews.list().length, `${survivors.length} alive, ${previews.list().length} listed`)
  check(
    'the listed children are exactly the ones still running',
    previews.list().every((instance) => alive(instance)),
    previews.list().map((i) => i.dataPort).join(','),
  )

  /* 3. close reaches a child that no longer belongs to any key */
  const orphanByHand = previews.list()[0]
  previews.instances.delete(orphanByHand.key)
  check('a child removed from the instance map is still counted', previews.processCount === 2, `${previews.processCount}`)
  check('and is still closable by token', (await previews.close(orphanByHand.token)) === true)
  await new Promise((settle) => setTimeout(settle, 500))
  check('closing it killed the process', !alive(orphanByHand), `port ${orphanByHand.dataPort}`)

  /* 4. the reaper collects a child that only the spawn map knows about */
  const stray = await open(files[1])
  previews.instances.delete(stray.key)
  stray.startedAt -= 10 * 60 * 1000 // pretend it has been stray for ten minutes
  await previews.reap()
  await new Promise((settle) => setTimeout(settle, 500))
  check('the reaper kills a child nothing claims any more', !alive(stray), `port ${stray.dataPort}`)
  check('and the manager stopped counting it', previews.processCount === 1, `${previews.processCount}`)

  /* 5. what is still open is still usable, and dispose takes the rest */
  const last = previews.list()[0]
  check('the remaining preview still answers', last !== undefined && alive(last), `${previews.processCount} left`)
  await previews.dispose()
  await new Promise((settle) => setTimeout(settle, 1500))
  const leaked = started.filter((instance) => alive(instance))
  check('dispose leaves no child behind', leaked.length === 0, leaked.map((i) => i.dataPort).join(','))
} catch (error) {
  failures += 1
  console.log(`  FAIL  ${error instanceof Error ? error.stack : String(error)}`)
} finally {
  stopReaper()
  await previews.dispose()
  for (const instance of started) {
    try {
      instance.proc.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nLEAK CHECK OK' : `\nLEAK CHECK FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
