import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import Search from './Search';
import Dashboard from './Dashboard';

export default function App() {
  return (
    <BrowserRouter>
      <nav style={{ display: 'flex', gap: 16, padding: 12, borderBottom: '1px solid #ddd' }}>
        <Link to="/">Search</Link>
        <Link to="/dashboard">Dashboard</Link>
      </nav>
      <main style={{ padding: 16, maxWidth: 760 }}>
        <Routes>
          <Route path="/" element={<Search />} />
          <Route path="/dashboard" element={<Dashboard />} />
        </Routes>
      </main>
    </BrowserRouter>
  );
}
