import { readFile, readdir } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { join } from 'node:path'

const assetsDir = join(process.cwd(), 'dist', 'assets')
const budgets = [
  { name: 'main', pattern: /^main-.+\.js$/, bytes: 400_000, gzipBytes: 150_000 },
  { name: 'PaidApp', pattern: /^PaidApp-.+\.js$/, bytes: 400_000, gzipBytes: 150_000 },
  { name: 'index', pattern: /^index-.+\.js$/, bytes: 400_000, gzipBytes: 150_000 },
]

const files = (await readdir(assetsDir)).filter((file) => file.endsWith('.js'))
const checked = []
const failures = []

for (const budget of budgets) {
  const matches = files.filter((file) => budget.pattern.test(file))
  if (matches.length === 0) {
    failures.push(`${budget.name}: no generated entry chunk matched ${budget.pattern}`)
    continue
  }
  for (const file of matches) {
    const body = await readFile(join(assetsDir, file))
    const gzipBytes = gzipSync(body).byteLength
    checked.push({ file, bytes: body.byteLength, gzipBytes })
    if (body.byteLength > budget.bytes || gzipBytes > budget.gzipBytes) {
      failures.push(
        `${file}: ${body.byteLength} bytes / ${gzipBytes} gzip exceeds ${budget.bytes} / ${budget.gzipBytes}`,
      )
    }
  }
}

for (const item of checked) {
  console.log(
    `[bundle] ${item.file}: ${item.bytes} bytes / ${item.gzipBytes} gzip (budget 400000 / 150000)`,
  )
}

if (failures.length > 0) {
  console.error('[bundle] budget check failed')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('[bundle] entry budgets passed; optional provider chunks are lazy-loaded')
