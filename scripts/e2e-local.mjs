/**
 * Local end-to-end: stop any chain on 8545, start a PRISTINE Hardhat EVM node,
 * deploy the contracts, and run the server's chain-backed integration suite
 * (real faucet/approve/pay txs, real receipt validation, real mint tx). The
 * chain node is left running for manual use.
 */
import { spawn } from 'node:child_process'

const isWin = process.platform === 'win32'
const npm = isWin ? 'npm.cmd' : 'npm'

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit', shell: isWin })
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(cmd + ' exited with ' + code)),
    )
  })
}

/** Stops any chain already listening on 8545 so every run starts pristine. */
async function stopChain() {
  await new Promise((resolve) => {
    const command = isWin
      ? '$c = Get-NetTCPConnection -State Listen -LocalPort 8545 -ErrorAction SilentlyContinue; if ($c) { Stop-Process -Id $c.OwningProcess -Force }'
      : 'fuser -k 8545/tcp >/dev/null 2>&1 || true'
    const shell = isWin ? 'powershell' : 'bash'
    const args = isWin ? ['-NoProfile', '-Command', command] : ['-c', command]
    const child = spawn(shell, args, { stdio: 'ignore' })
    child.on('exit', () => resolve())
  })
  await new Promise((resolve) => setTimeout(resolve, 1000))
}

async function chainUp() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch('http://127.0.0.1:8545', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      })
      if (res.ok) return true
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

async function main() {
  await stopChain()
  console.log('[e2e] starting a pristine hardhat node…')
  spawn(npm, ['run', 'node'], { cwd: 'contracts', stdio: 'ignore', detached: !isWin, shell: isWin })
  if (!(await chainUp())) throw new Error('hardhat node did not come up on http://127.0.0.1:8545')
  console.log('[e2e] chain up · deploying contracts…')
  await run(npm, ['run', 'deploy:local'], 'contracts')
  console.log('[e2e] running server integration suite (real EVM end-to-end)…')
  await run(npm, ['run', 'test:integration'], 'apps/server')
  console.log('[e2e] done — the local chain is still running for manual use')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
