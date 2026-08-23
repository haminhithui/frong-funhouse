/**
 * Local end-to-end: start a PRISTINE Hardhat EVM node on a free 8545 port,
 * deploy the contracts, and run the server's chain-backed integration suite
 * (real faucet/approve/pay txs, real receipt validation, real mint tx).
 * The exact child process started here is always stopped before this script
 * exits, so an E2E run cannot kill an unrelated developer chain or leak a
 * background node.
 */
import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'

const isWin = process.platform === 'win32'
const npm = isWin ? 'npm.cmd' : 'npm'

function quoteWindowsArg(value) {
  const arg = String(value)
  if (!/[\s"&|<>^]/.test(arg)) return arg
  return '"' + arg.replace(/(["^])/g, '^$1') + '"'
}

/** Runs npm without shell:true; Windows uses an explicit cmd.exe boundary. */
function spawnTool(cmd, args, options) {
  if (!isWin) return spawn(cmd, args, options)
  const commandLine = [cmd, ...args].map(quoteWindowsArg).join(' ')
  return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', commandLine], options)
}

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawnTool(cmd, args, { cwd, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(cmd + ' exited with ' + code)),
    )
  })
}

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.setTimeout(500)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    const free = () => {
      socket.destroy()
      resolve(false)
    }
    socket.once('timeout', free)
    socket.once('error', free)
  })
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

async function stopProcess(child) {
  if (!child || child.exitCode !== null || !child.pid) return
  if (isWin) {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      killer.on('error', resolve)
      killer.on('exit', resolve)
    })
    return
  }
  child.kill('SIGTERM')
  await new Promise((resolve) => child.once('exit', resolve))
}

async function main() {
  if (await portInUse(8545)) {
    throw new Error('port 8545 is already in use; stop the exact owner before running local E2E')
  }
  console.log('[e2e] starting a pristine hardhat node…')
  const chain = spawnTool(npm, ['run', 'node'], {
    cwd: 'contracts',
    stdio: 'ignore',
    windowsHide: true,
  })
  try {
    if (!(await chainUp())) {
      throw new Error('hardhat node did not come up on http://127.0.0.1:8545')
    }
    console.log('[e2e] chain up · deploying contracts…')
    await run(npm, ['run', 'deploy:local'], 'contracts')
    console.log('[e2e] running server integration suite (real EVM end-to-end)…')
    await run(npm, ['run', 'test:integration'], 'apps/server')
    console.log('[e2e] integration passed')
  } finally {
    console.log('[e2e] stopping the exact hardhat child process')
    await stopProcess(chain)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
