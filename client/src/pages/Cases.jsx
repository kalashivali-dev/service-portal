import { useState, useEffect } from 'react';
import StatusBadge from '../components/StatusBadge';
import './Cases.css';

const FALLBACK_CASES = [
  { id: 'CASE-001', title: 'Payroll discrepancy for Q2', status: 'Open', assignedTo: 'Alice Johnson', date: '2026-07-01' },
  { id: 'CASE-002', title: 'IT equipment request - Marketing dept', status: 'In Progress', assignedTo: 'Bob Martinez', date: '2026-07-02' },
  { id: 'CASE-003', title: 'Onboarding docs missing for new hire', status: 'Open', assignedTo: 'Carol Smith', date: '2026-07-03' },
  { id: 'CASE-004', title: 'Office 365 license renewal', status: 'Resolved', assignedTo: 'David Lee', date: '2026-06-28' },
  { id: 'CASE-005', title: 'VPN access request - Remote team', status: 'In Progress', assignedTo: 'Eve Nguyen', date: '2026-07-04' },
  { id: 'CASE-006', title: 'Benefits enrollment window inquiry', status: 'Resolved', assignedTo: 'Frank Wilson', date: '2026-06-25' },
  { id: 'CASE-007', title: 'Conference room booking conflict', status: 'Open', assignedTo: 'Grace Kim', date: '2026-07-05' },
  { id: 'CASE-008', title: 'Software license audit - Design tools', status: 'In Progress', assignedTo: 'Henry Park', date: '2026-07-06' },
];

function Cases() {
  const [cases, setCases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState('All');

  useEffect(() => {
    fetch('http://localhost:3001/api/cases')
      .then((r) => {
        if (!r.ok) throw new Error('API error');
        return r.json();
      })
      .then((data) => {
        setCases(data);
        setLoading(false);
      })
      .catch(() => {
        setCases(FALLBACK_CASES);
        setLoading(false);
      });
  }, []);

  const statuses = ['All', 'Open', 'In Progress', 'Resolved'];
  const filtered =
    filterStatus === 'All' ? cases : cases.filter((c) => c.status === filterStatus);

  return (
    <div className="cases-page">
      <div className="page-header">
        <div>
          <h2 className="page-title">Cases</h2>
          <p className="page-subtitle">Manage and track all service cases.</p>
        </div>
        <button className="btn btn--primary">+ New Case</button>
      </div>

      <div className="cases-toolbar">
        <div className="filter-tabs">
          {statuses.map((s) => (
            <button
              key={s}
              className={`filter-tab${filterStatus === s ? ' filter-tab--active' : ''}`}
              onClick={() => setFilterStatus(s)}
            >
              {s}
              {s !== 'All' && (
                <span className="filter-tab__count">
                  {cases.filter((c) => c.status === s).length}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="table-card">
        {loading ? (
          <div className="table-loading">Loading cases...</div>
        ) : (
          <table className="cases-table">
            <thead>
              <tr>
                <th>Case ID</th>
                <th>Title</th>
                <th>Status</th>
                <th>Assigned To</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={5} className="table-empty">No cases found.</td>
                </tr>
              ) : (
                filtered.map((c) => (
                  <tr key={c.id}>
                    <td className="cases-table__id">{c.id}</td>
                    <td className="cases-table__title">{c.title}</td>
                    <td>
                      <StatusBadge status={c.status} />
                    </td>
                    <td className="cases-table__assigned">{c.assignedTo}</td>
                    <td className="cases-table__date">{c.date}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export default Cases;
