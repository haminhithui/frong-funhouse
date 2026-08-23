const ADDRESS = /^0x[0-9a-fA-F]{40}$/

export function requireAddress(value: string, label: string): string {
  if (!ADDRESS.test(value)) {
    throw new Error(label + ' must be a valid Ethereum address')
  }
  if (/^0x0{40}$/i.test(value)) {
    throw new Error(label + ' must not be the zero address')
  }
  return value
}

export function requirePositiveWei(value: string, label: string): bigint {
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(label + ' must be a non-negative integer in wei')
  }
  const parsed = BigInt(value)
  if (parsed <= 0n) throw new Error(label + ' must be positive')
  return parsed
}

export function requirePublicHttpsUrl(value: string, label: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(label + ' must be a public https:// URL')
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
  ) {
    throw new Error(label + ' must be a public https:// URL')
  }
  return value
}
