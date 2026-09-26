const BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');

async function req(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${opts.method || 'GET'} ${path} -> ${res.status} ${body.slice(0, 200)}`);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : res.text();
}

export const api = {
  search: (q) => req(`/search?q=${encodeURIComponent(q)}`),
  track: (productId, optionId, optionLabel) =>
    req('/track', { method: 'POST', body: JSON.stringify({ productId, optionId, optionLabel }) }),
  tracked: () => req('/tracked'),
  history: (productId, optionId) =>
    req(`/products/${encodeURIComponent(productId)}/history?optionId=${encodeURIComponent(optionId)}`),
  logs: (productId, optionId) =>
    req(`/products/${encodeURIComponent(productId)}/logs?optionId=${encodeURIComponent(optionId)}`),
  exportCsvUrl: () => `${BASE}/export.csv`,
};
