import { useEffect, useMemo, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceDot } from 'recharts';
import { api } from './api';

const badge = (outcome) => ({
  success: { background: '#d4edda', color: '#155724' },
  retried: { background: '#fff3cd', color: '#856404' },
  failed: { background: '#f8d7da', color: '#721c24' },
}[outcome] || {});

function fmtTime(ts) {
  return new Date(ts).toLocaleString();
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

  return (
    <div>
      <button onClick={onBack}>← Back to tracked</button>
      <h2>{item.name} <small>({item.optionLabel})</small></h2>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      {loading && <p>Loading price history… (first load after idle can take ~30–60s while the free backend wakes up)</p>}

      <h3>Price over time</h3>
      {!loading && chartData.length === 0 && <p>No history yet — wait for the next scheduled scrape.</p>}
      {chartData.length > 0 && (
        <LineChart width={640} height={280} data={chartData}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="ts" tickFormatter={(t) => tickLabel(t)} type="number" domain={['auto', 'auto']} />
          <YAxis domain={['auto', 'auto']} />
          <Tooltip labelFormatter={(t) => fmtTime(t)} />
          <Line type="monotone" dataKey="priceNum" connectNulls={false} dot={false} name="price" />
          {badPoints.map((d, i) => (
            <ReferenceDot key={i} x={d.ts} y={d.priceNum} r={5} fill="red" stroke="none" />
          ))}
        </LineChart>
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
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.tracked()
      .then((d) => setTracked(d.tracked || []))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (selected) return <Detail item={selected} onBack={() => setSelected(null)} />;

  return (
    <section>
      <h1>Dashboard</h1>
      <p><a href={api.exportCsvUrl()}><button>Export CSV</button></a></p>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      {loading && <p>Loading tracked products…</p>}
      {!loading && tracked.length === 0 && <p>Nothing tracked yet — go to Search to track a product.</p>}
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {tracked.map((t) => (
          <li key={t.id} style={{ border: '1px solid #ddd', margin: '8px 0', padding: 12 }}>
            <strong>{t.name}</strong> <small>({t.optionLabel})</small>
            <div><button onClick={() => setSelected(t)}>Open detail</button></div>
          </li>
        ))}
      </ul>
    </section>
  );
}
