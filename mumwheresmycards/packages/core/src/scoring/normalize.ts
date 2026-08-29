export function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** Linearly maps [0, cap] -> [0, 1], clamping outside the range. */
export function normalizeCapped(value: number, cap: number): number {
  if (cap <= 0) return 0;
  return clamp01(value / cap);
}

/** Linearly maps [min, max] -> [0, 1], clamping outside the range. */
export function normalizeRange(value: number, min: number, max: number): number {
  if (max <= min) return 0;
  return clamp01((value - min) / (max - min));
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
