// Seeded random streams. Rules, decoration, and audiovisual variants each use
// their own stream so cosmetic randomness can never perturb rules outcomes.

export function hashString(str) {
  // FNV-1a 32-bit
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function makeStream(seed) {
  // mulberry32
  let a = (typeof seed === 'string' ? hashString(seed) : seed >>> 0) || 0x9e3779b9;
  const api = {
    get state() { return a >>> 0; },
    set state(v) { a = v >>> 0 || 0x9e3779b9; },
    next() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    int(n) { // uniform in [0, n)
      return Math.floor(api.next() * n);
    },
    range(lo, hi) { // uniform in [lo, hi] inclusive
      return lo + api.int(hi - lo + 1);
    },
    pick(arr) { return arr[api.int(arr.length)]; },
    shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = api.int(i + 1);
        const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
      }
      return arr;
    },
    fork(tag) { // derive an independent stream
      return makeStream((a ^ hashString(String(tag))) >>> 0);
    },
  };
  return api;
}
