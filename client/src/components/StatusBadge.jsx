import './StatusBadge.css';

function StatusBadge({ status }) {
  const slug = status.toLowerCase().replace(' ', '-');
  return <span className={`badge badge--${slug}`}>{status}</span>;
}

export default StatusBadge;
