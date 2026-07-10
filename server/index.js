const express = require('express');
const cors = require('cors');

const app = express();
const PORT = 3001;

app.use(cors({ origin: 'http://localhost:5173' }));
app.use(express.json());

const mockCases = [
  {
    id: 'CASE-001',
    title: 'Payroll discrepancy for Q2',
    status: 'Open',
    assignedTo: 'Alice Johnson',
    date: '2026-07-01',
  },
  {
    id: 'CASE-002',
    title: 'IT equipment request - Marketing dept',
    status: 'In Progress',
    assignedTo: 'Bob Martinez',
    date: '2026-07-02',
  },
  {
    id: 'CASE-003',
    title: 'Onboarding docs missing for new hire',
    status: 'Open',
    assignedTo: 'Carol Smith',
    date: '2026-07-03',
  },
  {
    id: 'CASE-004',
    title: 'Office 365 license renewal',
    status: 'Resolved',
    assignedTo: 'David Lee',
    date: '2026-06-28',
  },
  {
    id: 'CASE-005',
    title: 'VPN access request - Remote team',
    status: 'In Progress',
    assignedTo: 'Eve Nguyen',
    date: '2026-07-04',
  },
  {
    id: 'CASE-006',
    title: 'Benefits enrollment window inquiry',
    status: 'Resolved',
    assignedTo: 'Frank Wilson',
    date: '2026-06-25',
  },
  {
    id: 'CASE-007',
    title: 'Conference room booking conflict',
    status: 'Open',
    assignedTo: 'Grace Kim',
    date: '2026-07-05',
  },
  {
    id: 'CASE-008',
    title: 'Software license audit - Design tools',
    status: 'In Progress',
    assignedTo: 'Henry Park',
    date: '2026-07-06',
  },
];

// GET /api/cases
app.get('/api/cases', (req, res) => {
  res.json(mockCases);
});

// GET /api/stats
app.get('/api/stats', (req, res) => {
  const open = mockCases.filter((c) => c.status === 'Open').length;
  const inProgress = mockCases.filter((c) => c.status === 'In Progress').length;
  const resolved = mockCases.filter((c) => c.status === 'Resolved').length;
  res.json({ open, inProgress, resolved });
});

app.listen(PORT, () => {
  console.log(`Service Portal API running on http://localhost:${PORT}`);
});
