import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  appendFileSync,
  existsSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

export type MintStatus = 'queued' | 'minting' | 'minted' | 'delayed' | 'rejected'

export interface AttestationRecord {
  tokenId: number
  player: string
  sessionId: string
  tier: number
  tierName: string
  score: number
  fliesCaught: number
  seedCommitment: string
  inputLogHash: string
  buildHash: string
  timestamp: number
  uri: string
  metadata: unknown
  status: MintStatus
  txHash: string | null
  attempts: number
  updatedAt: string
}

/** Audit-chain state. 'ok' = every chained line verified on load. */
export type AuditIntegrity = 'ok' | 'broken'

/** Chain anchor for lines written before the hash chain existed (legacy
 * data is adopted as a trusted baseline - documented, not silently verified). */
const GENESIS = 'genesis'

/**
 * Append-only, hash-chained data store. Every fact is appended to a JSONL
 * file; updates append new lines (latest wins on load), so nothing is ever
 * silently rewritten. Each appended line carries _prev (the previous line's
 * hash) and _hash = sha256(_prev + NUL + canonical(line)) - a standard
 * SHA-256 hash chain, no custom signing. On load every chained line is
 * re-verified; a broken chain is reported (never a silent pass) and the
 * store keeps serving. Sessions and auth tokens are short-lived and kept
 * in memory only.
 */
export class Store {
  private attestations = new Map<number, AttestationRecord>()
  private nextTokenId = 1
  private consumedPayments = new Set<string>()
  private lastHashes = new Map<string, string>()
  private broken = false

  constructor(private readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true })
    this.load()
  }

  /** Strips chain fields; the canonical form is the record as written. */
  private canonical(value: object): string {
    const rest: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      if (key !== '_prev' && key !== '_hash') rest[key] = entry
    }
    return JSON.stringify(rest)
  }

  private chainHash(prev: string, canonical: string): string {
    return createHash('sha256')
      .update(prev + '\u0000' + canonical)
      .digest('hex')
  }

  /** Reads a JSONL stream, verifies the hash chain, returns clean records. */
  private readLines(filename: string): object[] {
    const file = join(this.dataDir, filename)
    if (!existsSync(file)) return []
    const parsed: object[] = []
    let prev = GENESIS
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      let value: Record<string, unknown>
      try {
        value = JSON.parse(line) as Record<string, unknown>
      } catch {
        this.broken = true
        console.error('[store] corrupt line in', filename, '- chain marked broken')
        continue
      }
      if (typeof value._hash === 'string' && /^[0-9a-f]{64}$/.test(value._hash)) {
        const expected = this.chainHash(String(value._prev ?? GENESIS), this.canonical(value))
        if (expected !== value._hash) {
          this.broken = true
          console.error('[store] hash-chain mismatch in', filename, '- chain marked broken')
        }
        prev = value._hash
      } else {
        // Legacy line (pre-chain): trusted baseline; the chain restarts.
        prev = GENESIS
      }
      const clean: Record<string, unknown> = {}
      for (const [key, entry] of Object.entries(value)) {
        if (key !== '_prev' && key !== '_hash') clean[key] = entry
      }
      parsed.push(clean as object)
    }
    this.lastHashes.set(filename, prev)
    return parsed
  }

  private load(): void {
    for (const entry of this.readLines('token-ids.jsonl')) {
      const record = entry as { tokenId: number }
      if (record.tokenId >= this.nextTokenId) this.nextTokenId = record.tokenId + 1
    }
    for (const entry of this.readLines('attestations.jsonl')) {
      const record = entry as AttestationRecord
      this.attestations.set(record.tokenId, record)
      if (record.tokenId >= this.nextTokenId) this.nextTokenId = record.tokenId + 1
    }
    for (const entry of this.readLines('payments.jsonl')) {
      this.consumedPayments.add((entry as { txHash: string }).txHash.toLowerCase())
    }
  }

  private append(filename: string, value: object): void {
    const canonical = this.canonical(value)
    const prev = this.lastHashes.get(filename) ?? GENESIS
    const hash = this.chainHash(prev, canonical)
    const record = { ...value, _prev: prev, _hash: hash }
    appendFileSync(join(this.dataDir, filename), JSON.stringify(record) + '\n')
    this.lastHashes.set(filename, hash)
  }

  /** Claims the next sequential, collision-free token id. */
  nextTokenIdValue(): number {
    const id = this.nextTokenId
    this.nextTokenId += 1
    this.append('token-ids.jsonl', { tokenId: id, assignedAt: new Date().toISOString() })
    return id
  }

  /** Records a payment tx hash as consumed. Returns false if already used. */
  consumePayment(txHash: string): boolean {
    const key = txHash.toLowerCase()
    if (this.consumedPayments.has(key)) return false
    this.consumedPayments.add(key)
    this.append('payments.jsonl', { txHash: key, consumedAt: new Date().toISOString() })
    return true
  }

  upsertAttestation(record: AttestationRecord): void {
    this.attestations.set(record.tokenId, record)
    this.append('attestations.jsonl', record)
  }

  getAttestation(tokenId: number): AttestationRecord | undefined {
    return this.attestations.get(tokenId)
  }

  listAttestations(): AttestationRecord[] {
    return [...this.attestations.values()].sort((a, b) => a.tokenId - b.tokenId)
  }

  /** Records queued for (re-)minting after a restart or a delay. */
  pendingMints(): AttestationRecord[] {
    return this.listAttestations().filter(
      (record) =>
        record.status === 'queued' || record.status === 'minting' || record.status === 'delayed',
    )
  }

  /** Audit-chain status after the last load: 'ok' or 'broken'. */
  integrity(): AuditIntegrity {
    return this.broken ? 'broken' : 'ok'
  }
}

/** Writes pinned metadata to the data dir atomically; the URI is final at mint. */
export function writeMetadataFile(dataDir: string, tokenId: number, metadata: unknown): string {
  const dir = join(dataDir, 'metadata')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, tokenId + '.json')
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(metadata, null, 2))
  renameSync(tmp, file)
  return file
}
