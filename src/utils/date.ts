export function daysBetween(dateA: string, dateB: string) {
  return Math.abs((new Date(dateA).getTime() - new Date(dateB).getTime()) / (1000 * 60 * 60 * 24));
}
