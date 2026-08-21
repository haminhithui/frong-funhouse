interface ErrorWithExtras {
  details?: string
  metaMessages?: string[]
  data?: { errorName?: string }
}

/** Shared test helpers: revert assertion that sees through viem's error wrapping. */
export async function expectRevert(promise: Promise<unknown>, message: string): Promise<void> {
  try {
    await promise
  } catch (error) {
    const err = error as ErrorWithExtras
    const text = [
      String(error),
      err.details ?? '',
      (err.metaMessages ?? []).join(' '),
      err.data?.errorName ?? '',
    ].join(' | ')
    if (text.includes(message)) return
    throw new Error('expected revert containing "' + message + '", got: ' + text)
  }
  throw new Error('expected revert containing "' + message + '", but the call succeeded')
}
