import { useLocation } from 'react-router-dom';
import './Header.css';

const pageTitles = {
  '/dashboard': 'Dashboard',
  '/cases': 'Cases',
  '/staff': 'Staff',
  '/settings': 'Settings',
};

function Header() {
  const location = useLocation();
  const title = pageTitles[location.pathname] || 'Service Portal';

  return (
    <header className="header">
      <div className="header__left">
        <h1 className="header__title">{title}</h1>
      </div>
      <div className="header__right">
        <span className="header__org-name">Service Portal</span>
        <div className="header__avatar" title="Jane Doe">
          JD
        </div>
      </div>
    </header>
  );
}

export default Header;
