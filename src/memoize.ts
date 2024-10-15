export function memoize<K, V>(cb: (a: K) => V): ((a: K) => V) & { memoized: Map<K, V> } {
  const memoized = new Map<K, V>()
  return Object.assign(
    (a: K) => {
      if (!memoized.has(a)) {
        const ret = cb(a)
        memoized.set(a, ret)
        return ret
      }
      return memoized.get(a)!
    },
    { memoized }
  )
}
