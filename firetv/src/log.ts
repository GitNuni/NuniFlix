// Debug builds only: send a line to the Metro dev server on the Mac (metro.config.js prints it), since Vega's
// device log doesn't show JavaScript's console. Release builds never send anything.
export function log(...parts: unknown[]) {
  if (!__DEV__) return;
  const line = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  fetch('http://localhost:8081/nf-log', {method: 'POST', body: line}).catch(() => {});
}
