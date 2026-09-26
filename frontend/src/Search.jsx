import { useState } from 'react';
import { api } from './api';

export default function Search() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [picked, setPicked] = useState({}); // productId -> optionId
  const [tracking, setTracking] = useState(null);

  async function run(e) {
    e.preventDefault();
    if (!q.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.search(q.trim());
      setResults(data.results || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function track(r) {
    const optionId = picked[r.productId] || (r.options[0] && r.options[0].optionId);
    const opt = r.options.find((o) => o.optionId === optionId);
    if (!opt) return;
    setTracking(r.productId);
    setError(null);
    try {
      await api.track(r.productId, opt.optionId, opt.label);
      alert(`Tracking ${r.name} (${opt.label})`);
    } catch (err) {
      setError(err.message);
    } finally {
      setTracking(null);
    }
  }

  // Bonus: track ALL options of a product in one call — /scrape/all then
  // scrapes them together in one batch run.
  async function trackAll(r) {
    setTracking(`${r.productId}:all`);
    setError(null);
    try {
      const data = await api.trackBulk(
        r.productId,
        r.options.map((o) => ({ optionId: o.optionId, optionLabel: o.label }))
      );
      const ok = (data.results || []).filter((x) => x.ok).length;
      alert(`Tracking ${ok}/${r.options.length} options of ${r.name}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setTracking(null);
    }
  }

  return (
    <section>
      <h1>Search the store</h1>
      <form onSubmit={run} style={{ display: 'flex', gap: 8 }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Partial or full product name…"
          style={{ flex: 1, padding: 8 }}
        />
        <button type="submit" disabled={loading}>{loading ? 'Searching…' : 'Search'}</button>
      </form>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {results.map((r) => (
          <li key={r.productId} style={{ border: '1px solid #ddd', margin: '8px 0', padding: 12 }}>
            <strong>{r.name}</strong> <small>id: {r.productId}</small>
            {(r.brand || r.category || r.sku) && (
              <div style={{ marginTop: 4 }}>
                {[r.brand, r.category, r.sku].filter(Boolean).map((c) => (
                  <span key={c} className="chip">{c}</span>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
              <select
                value={picked[r.productId] || (r.options[0] && r.options[0].optionId) || ''}
                onChange={(e) => setPicked({ ...picked, [r.productId]: e.target.value })}
              >
                {r.options.map((o) => (
                  <option key={o.optionId} value={o.optionId}>{o.label}</option>
                ))}
              </select>
              <button onClick={() => track(r)} disabled={tracking === r.productId}>
                {tracking === r.productId ? 'Tracking…' : 'Track'}
              </button>
              {r.options.length > 1 && (
                <button onClick={() => trackAll(r)} disabled={tracking === `${r.productId}:all`} title="Track every option of this product">
                  {tracking === `${r.productId}:all` ? 'Tracking…' : `Track all ${r.options.length}`}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {!loading && results.length === 0 && <p>No results yet — search above.</p>}
    </section>
  );
}
