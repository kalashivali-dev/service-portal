import { useState, useEffect } from 'react';
import './Dashboard.css';

function StatCard({ label, value, color, icon }) {
  return (
    <div className="stat-card" style={{ '--card-color': color }}>
      <div className="stat-card__icon">{icon}</div>
      <div className="stat-card__body">
        <p className="stat-card__label">{label}</p>
        <p className="stat-card__value">{value ?? '—'}</p>
      </div>
    </div>
  );
}

function Dashboard() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch('http://localhost:3001/api/stats')
      .then((r) => {
        if (!r.ok) throw new Error('Failed to fetch stats');
        return r.json();
      })
      .then((data) => {
        setStats(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  return (
    <div className="dashboard">
      <div className="page-header">
        <h2 className="page-title">Overview</h2>
        <p className="page-subtitle">Welcome back. Here's what's happening today.</p>
      </div>

      {error && (
        <div className="dashboard__error">
          Could not load stats from API: {error}. Showing placeholder values.
        </div>
      )}

      <div className="stat-cards">
        <StatCard
          label="Open Cases"
          value={loading ? '...' : stats?.open ?? 3}
          color="var(--color-open)"
          icon={
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          }
        />
        <StatCard
          label="In Progress"
          value={loading ? '...' : stats?.inProgress ?? 2}
          color="var(--color-inprogress)"
          icon={
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
          }
        />
        <StatCard
          label="Resolved"
          value={loading ? '...' : stats?.resolved ?? 2}
          color="var(--color-resolved)"
          icon={
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          }
        />
      </div>

      <div className="dashboard__section">
        <h3 className="section-title">Recent Activity</h3>
        <div className="activity-list">
          {[
            { text: 'CASE-007 opened — Conference room booking conflict', time: '2 hours ago', dot: 'open' },
            { text: 'CASE-005 moved to In Progress — VPN access request', time: '5 hours ago', dot: 'inprogress' },
            { text: 'CASE-004 resolved — Office 365 license renewal', time: '1 day ago', dot: 'resolved' },
            { text: 'CASE-003 assigned to Carol Smith', time: '2 days ago', dot: 'open' },
            { text: 'CASE-006 resolved — Benefits enrollment inquiry', time: '3 days ago', dot: 'resolved' },
          ].map((item, i) => (
            <div key={i} className="activity-item">
              <span className={`activity-dot activity-dot--${item.dot}`} />
              <span className="activity-text">{item.text}</span>
              <span className="activity-time">{item.time}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default Dashboard;
