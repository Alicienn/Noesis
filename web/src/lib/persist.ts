import { useEffect, useState } from 'react'

/** useState persisted in localStorage (per-browser UI preferences only). */
export function usePersistentState<T>(key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(`noesis.${key}`)
      return raw === null ? initial : (JSON.parse(raw) as T)
    } catch {
      return initial
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(`noesis.${key}`, JSON.stringify(value))
    } catch {
      // storage unavailable: preference simply isn't remembered
    }
  }, [key, value])
  return [value, setValue]
}
