export function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function sanitizeMoney(value: number) {
  return Math.round(Math.max(0, value));
}
