export function log(...args: any[]) {
  if (process.env.NODE_ENV !== 'test') {
    // eslint-disable-next-line no-console
    console.log('[HobbyIQ]', ...args);
  }
}
