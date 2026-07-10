import './Stub.css';

const mockStaff = [
  { name: 'Alice Johnson', role: 'Case Manager', department: 'Operations', status: 'Active' },
  { name: 'Bob Martinez', role: 'IT Support', department: 'Technology', status: 'Active' },
  { name: 'Carol Smith', role: 'HR Specialist', department: 'Human Resources', status: 'Active' },
  { name: 'David Lee', role: 'Systems Admin', department: 'Technology', status: 'Active' },
  { name: 'Eve Nguyen', role: 'Network Engineer', department: 'Technology', status: 'On Leave' },
  { name: 'Frank Wilson', role: 'Benefits Coordinator', department: 'Human Resources', status: 'Active' },
  { name: 'Grace Kim', role: 'Facilities Manager', department: 'Operations', status: 'Active' },
  { name: 'Henry Park', role: 'Software Engineer', department: 'Technology', status: 'Active' },
];

function getInitials(name) {
  return name.split(' ').map((n) => n[0]).join('');
}

function Staff() {
  return (
    <div className="staff-page">
      <div className="page-header">
        <div>
          <h2 className="page-title">Staff</h2>
          <p className="page-subtitle">View and manage staff members across departments.</p>
        </div>
        <button className="btn btn--primary">+ Add Member</button>
      </div>

      <div className="staff-grid">
        {mockStaff.map((member) => (
          <div key={member.name} className="staff-card">
            <div className="staff-card__avatar">{getInitials(member.name)}</div>
            <div className="staff-card__info">
              <p className="staff-card__name">{member.name}</p>
              <p className="staff-card__role">{member.role}</p>
              <p className="staff-card__dept">{member.department}</p>
            </div>
            <span className={`staff-card__status staff-card__status--${member.status === 'Active' ? 'active' : 'leave'}`}>
              {member.status}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default Staff;
