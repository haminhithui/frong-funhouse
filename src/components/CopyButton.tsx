import { useEffect, useRef, useState } from 'react'

interface CopyButtonProps {
  value: string
  label?: string
}

function fallbackCopy(text: string): boolean {
  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    const worked = document.execCommand('copy')
    textarea.remove()
    return worked
  } catch {
    return false
  }
}

/**
 * Copies a value to the clipboard. A real action: no clipboard support means
 * no feedback, and the address always stays visible for manual copying.
 */
export function CopyButton({ value, label = 'Copy' }: CopyButtonProps) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  async function handleCopy() {
    let worked = false
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(value)
        worked = true
      } catch {
        worked = false
      }
    }
    if (!worked) worked = fallbackCopy(value)

    if (worked) {
      setCopied(true)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <>
      <button
        type="button"
        className="copy-button"
        data-copied={copied}
        onClick={() => void handleCopy()}
      >
        {copied ? 'Copied' : label}
      </button>
      <span role="status" aria-live="polite" className="visually-hidden">
        {copied ? 'Copied to clipboard' : ''}
      </span>
    </>
  )
}
