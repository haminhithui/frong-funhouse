import '@testing-library/jest-dom/vitest'

// Node 26 ships an experimental `localStorage` global that shadows jsdom's
// implementation and errors without --localstorage-file. Install a simple
// in-memory Storage on window so storage-touching code stays testable.
function installMemoryStorage(): void {
  const backing = new Map<string, string>()
  const storage: Storage = {
    get length() {
      return backing.size
    },
    clear: () => {
      backing.clear()
    },
    getItem: (key: string) => (backing.has(key) ? (backing.get(key) ?? null) : null),
    key: (index: number) => {
      const keys = [...backing.keys()]
      return index >= 0 && index < keys.length ? (keys[index] ?? null) : null
    },
    removeItem: (key: string) => {
      backing.delete(key)
    },
    setItem: (key: string, value: string) => {
      backing.set(key, value)
    },
  }
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage })
}

installMemoryStorage()
