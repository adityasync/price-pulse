import { useEffect, useMemo, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceDot, ResponsiveContainer } from 'recharts';
import { api } from './api';

const badge = (outcome) => ({
  success: { background: '#d4edda', color: '#155724' },
  retried: { background: '#fff3cd', color: '#856404' },
  failed: { background: '#f8d7da', color: '#721c24' },
}[outcome] || {});

function fmtTime(ts) {
  return new Date(ts).toLocaleString();
}

// Bonus: in-app alerts computed from the last two successful readings.
// Returns null | { type: 'drop', amount } | { type: 'back' }.
function alertFor(history) {
  const ok = (history || []).filter((h) => h.outcome === 'success' && h.price !== null);
  if (ok.length < 2) return null;
  const prev = ok[ok.length - 2];
  const cur = ok[ok.length - 1];
  if (Number(cur.price) < Number(prev.price))
    return { type: 'drop', amount: Number(prev.price) - Number(cur.price) };
  const wasOut = /sold out/i.test(prev.stock || '');
  const isIn = !/sold out/i.test(cur.stock || '');
  if (wasOut && isIn) return { type: 'back' };
  return null;
}

function AlertBadge({ alert }) {
  if (!alert) return null;
  return alert.type === 'drop' ? (
    <span style={{ background: '#d4edda', color: '#155724', padding: '2px 8px', borderRadius: 12, marginLeft: 8 }}>
      ↓ price drop ₹{alert.amount.toLocaleString('en-IN')}
    </span>
  ) : (
    <span style={{ background: '#cce5ff', color: '#004085', padding: '2px 8px', borderRadius: 12, marginLeft: 8 }}>
      back in stock
    </span>
  );
}

function timeAgo(ts) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// Minimal CSV row parser (handles quoted commas) for the export preview.
function parseCsvRow(line) {
  const cells = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { cells.push(cur); cur = ''; }
    else cur += c;
  }
  cells.push(cur);
  return cells;
}

// Same-day runs would all read "9/26/2026" — include clock time instead.
function tickLabel(t) {
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function Detail({ item, onBack }) {
  const [history, setHistory] = useState([]);
  const [logs, setLogs] = useState([]);
  const [showTable, setShowTable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    setError(null);
    setLoading(true);
    Promise.all([api.history(item.productId, item.optionId), api.logs(item.productId, item.optionId)])
      .then(([h, l]) => {
        if (!live) return;
        setHistory(h.history || []);
        setLogs(l.logs || []);
      })
      .catch((e) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [item]);

  const chartData = useMemo(
    () => history.map((h) => ({ ...h, ts: new Date(h.timestamp).getTime(), priceNum: h.price === null ? null : Number(h.price) })),
    [history]
  );
  // Failed runs carry price=null so they can't be plotted — the line gap
  // (connectNulls=false) plus the table below keep them visible, not hidden.
  const badPoints = chartData.filter((d) => d.outcome !== 'success' && d.priceNum !== null);
  const alert = useMemo(() => alertFor(history), [history]);
  const meta = item.meta || {};
  const lastQuote = meta.lastQuote || {};

  return (
    <div>
      <button onClick={onBack}>← Back to tracked</button>
      <h2>{item.name} <small>({item.optionLabel})</small><AlertBadge alert={alert} /></h2>
      {(meta.brand || meta.category || lastQuote.seller) && (
        <p style={{ color: '#444' }}>
          {[meta.brand, meta.category, meta.sku && `SKU ${meta.sku}`].filter(Boolean).join(' · ')}
          {lastQuote.seller && <> · sold by <strong>{lastQuote.seller}</strong></>}
          {lastQuote.rating != null && <> · ★ {lastQuote.rating}{lastQuote.ratingCount ? ` (${Number(lastQuote.ratingCount).toLocaleString('en-IN')} ratings)` : ''}</>}
          {lastQuote.mrp != null && <> · MRP ₹{Number(lastQuote.mrp).toLocaleString('en-IN')}</>}
        </p>
      )}
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      {loading && <p>Loading price history… (first load after idle can take ~30–60s while the free backend wakes up)</p>}

      <h3>Price over time</h3>
      {!loading && chartData.length === 0 && <p>No history yet — wait for the next scheduled scrape.</p>}
      {chartData.length > 0 && (
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="ts" tickFormatter={(t) => tickLabel(t)} type="number" domain={['auto', 'auto']} />
            <YAxis domain={['auto', 'auto']} width={70} />
            <Tooltip labelFormatter={(t) => fmtTime(t)} />
            <Line type="monotone" dataKey="priceNum" connectNulls={false} dot={false} name="price" />
            {badPoints.map((d, i) => (
              <ReferenceDot key={i} x={d.ts} y={d.priceNum} r={5} fill="red" stroke="none" />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}
      <p><span style={{ color: 'red' }}>●</span> red dots = failed/missing readings (never interpolated).</p>

      <button onClick={() => setShowTable(!showTable)}>{showTable ? 'Hide table' : 'Show as table'}</button>
      {showTable && (
        <table border="1" cellPadding="4" style={{ marginTop: 8, borderCollapse: 'collapse' }}>
          <thead><tr><th>timestamp (UTC)</th><th>price</th><th>stock</th><th>outcome</th></tr></thead>
          <tbody>
            {history.map((h, i) => (
              <tr key={i}>
                <td>{new Date(h.timestamp).toISOString()}</td>
                <td>{h.price ?? ''}</td>
                <td>{h.stock ?? ''}</td>
                <td><span style={{ ...badge(h.outcome), padding: '2px 6px', borderRadius: 4 }}>{h.outcome}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Scrape log</h3>
      <table border="1" cellPadding="4" style={{ borderCollapse: 'collapse' }}>
        <thead><tr><th>timestamp</th><th>attempt #</th><th>outcome</th><th>error detail</th></tr></thead>
        <tbody>
          {logs.map((l, i) => (
            <tr key={i}>
              <td>{fmtTime(l.timestamp)}</td>
              <td>{l.attemptNumber}</td>
              <td><span style={{ ...badge(l.outcome), padding: '2px 6px', borderRadius: 4 }}>{l.outcome}</span></td>
              <td title={l.errorDetail || ''}>{l.errorDetail ? l.errorDetail.slice(0, 80) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {logs.length === 0 && <p>No attempts logged yet.</p>}
    </div>
  );
}

export default function Dashboard() {
  const [tracked, setTracked] = useState([]);
  const [alerts, setAlerts] = useState({});
  const [latest, setLatest] = useState({});
  const [preview, setPreview] = useState(null);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    api.tracked()
      .then(async (d) => {
        const items = d.tracked || [];
        if (live) setTracked(items);
        // List-view alert badges: one history fetch per tracked product.
        const settled = await Promise.allSettled(items.map((t) => api.history(t.productId, t.optionId)));
        if (!live) return;
        const map = {};
        const last = {};
        settled.forEach((r, i) => {
          if (r.status === 'fulfilled') {
            const hist = r.value.history || [];
            const a = alertFor(hist);
            if (a) map[items[i].id] = a;
            const ok = hist.filter((h) => h.outcome === 'success' && h.price !== null);
            if (ok.length) last[items[i].id] = ok[ok.length - 1];
          }
        });
        setAlerts(map);
        setLatest(last);
      })
      .catch((e) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, []);

  async function previewCsv() {
    if (preview) { setPreview(null); return; }
    try {
      const text = await (await fetch(api.exportCsvUrl())).text();
      const lines = text.split('\n').filter((l) => l.trim() !== '');
      setPreview({
        count: Math.max(0, lines.length - 1),
        header: parseCsvRow(lines[0] || ''),
        rows: lines.slice(1).slice(-5).reverse().map(parseCsvRow),
      });
    } catch (e) {
      setError(e.message);
    }
  }

  if (selected) return <Detail item={selected} onBack={() => setSelected(null)} />;

  return (
    <section>
      <h1>Dashboard</h1>
      <p>
        <a href={api.exportCsvUrl()}><button>Export CSV</button></a>{' '}
        <button onClick={previewCsv} style={{ background: '#fff', color: 'var(--accent)', border: '1px solid var(--accent)' }}>
          {preview ? 'Hide preview' : 'Preview'}
        </button>
      </p>
      {preview && (
        <div>
          <small>{preview.count} scrape attempts in file · latest 5 below</small>
          <table border="1" cellPadding="4" style={{ borderCollapse: 'collapse', fontSize: '0.8rem' }}>
            <thead><tr>{preview.header.map((c) => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>
              {preview.rows.map((r, i) => (
                <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      {loading && <p>Loading tracked products…</p>}
      {!loading && tracked.length === 0 && <p>Nothing tracked yet — go to Search to track a product.</p>}
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {tracked.map((t) => (
          <li key={t.id} style={{ border: '1px solid #ddd', margin: '8px 0', padding: 12 }}>
            <strong>{t.name}</strong> <small>({t.optionLabel})</small>
            <AlertBadge alert={alerts[t.id]} />
            {latest[t.id] && (
              <div className="latest">
                ₹{Number(latest[t.id].price).toLocaleString('en-IN')} · {latest[t.id].stock} · <small>{timeAgo(latest[t.id].timestamp)}</small>
              </div>
            )}
            <div style={{ marginTop: 6 }}><button onClick={() => setSelected(t)}>Open detail</button></div>
          </li>
        ))}
      </ul>
    </section>
  );
}
