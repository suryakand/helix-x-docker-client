import { useEffect, useRef, useState } from 'react'

/**
 * True once the element has come within `margin` of the visible area (and stays true afterwards).
 * Used to fetch per-row data only for rows the user can actually see.
 */
export function useInView<T extends Element>(margin = '200px'): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null)
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || seen) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true)
          io.disconnect()
        }
      },
      { rootMargin: margin }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [margin, seen])
  return [ref, seen]
}
