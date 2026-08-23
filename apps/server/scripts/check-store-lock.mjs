import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

const serverDir = fileURLToPath(new URL('..', import.meta.url))
const dataDir = mkdtempSync(join(tmpdir(), 'frong-store-lock-'))
const holderCode =
  "import { Store } from './src/store.ts'; new Store(process.argv[1]); console.log('READY'); setInterval(() => {}, 1000);"
const holder = spawn(
  process.execPath,
  ['--import', 'tsx/esm', '--eval', holderCode, '--', dataDir],
  { cwd: serverDir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
)

let holderOutput = ''
holder.stdout.on('data', (chunk) => {
  holderOutput += String(chunk)
})
let holderError = ''
holder.stderr.on('data', (chunk) => {
  holderError += String(chunk)
})

try {
  const deadline = Date.now() + 10_000
  while (!holderOutput.includes('READY') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (!holderOutput.includes('READY')) {
    throw new Error('store lock holder did not start: ' + holderError)
  }

  const second = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx/esm',
      '--eval',
      "import { Store } from './src/store.ts'; try { new Store(process.argv[1]); console.log('UNEXPECTED_SECOND_STORE'); process.exitCode = 2 } catch (error) { console.log(String(error)) }",
      '--',
      dataDir,
    ],
    { cwd: serverDir, encoding: 'utf8', windowsHide: true },
  )
  const output = String(second.stdout) + String(second.stderr)
  if (second.status !== 0 || !output.includes('already owned by process')) {
    throw new Error('second process was not rejected by the store lock: ' + output)
  }
  console.log('store-lock: second process rejected as expected')
} finally {
  if (holder.exitCode === null) {
    holder.kill()
    await once(holder, 'close')
  }
  rmSync(dataDir, { recursive: true, force: true })
}
