import { loadConfig, configProblems } from './config'
import { computeSimBuildHash } from './simBuildHash'
import { Store } from './store'
import { createApp } from './http'
import { MintWorker } from './mintQueue'
import { createPrivyVerifier } from './privy'

export function boot() {
  const config = loadConfig()
  const problems = configProblems(config)
  if (problems.length > 0) {
    console.error('[boot] configuration problems:')
    for (const problem of problems) console.error('  -', problem)
    if (!process.env.ALLOW_INCOMPLETE_CONFIG) {
      process.exit(1)
    }
  }
  const buildHash = computeSimBuildHash()
  const store = new Store(config.dataDir)
  const privyVerifier = createPrivyVerifier(config)
  const app = createApp({ config, store, buildHash, privyVerifier })
  const worker = new MintWorker(config, store)

  app.listen(config.port, '127.0.0.1', () => {
    console.log('[boot] FRONG Catch server on http://127.0.0.1:' + config.port)
    console.log('[boot] chainId', config.chainId, 'rpc', config.rpcUrl)
    console.log('[boot] entry', config.entry, 'trophy', config.trophy, 'frong', config.frong)
    console.log('[boot] fee', config.feeAmount.toString(), 'wei · sim build hash', buildHash)
    console.log(
      '[boot] minter',
      config.minterKey ? 'configured' : 'NOT configured (minting disabled)',
    )
    console.log(
      '[boot] privy',
      !privyVerifier
        ? 'NOT configured (Privy login disabled)'
        : config.privyAppSecret
          ? 'configured (app secret — Privy API available)'
          : 'configured (public verification key — local token + wallet-linkage verification)',
    )
    worker.start()
  })

  const shutdown = () => {
    worker.stop()
    app.close(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  return { app, worker, config, store, buildHash }
}

if (require.main === module) {
  boot()
}
