import './Stub.css';

function SettingsSection({ title, children }) {
  return (
    <div className="settings-section">
      <h3 className="settings-section__title">{title}</h3>
      <div className="settings-section__body">{children}</div>
    </div>
  );
}

function SettingsRow({ label, description, children }) {
  return (
    <div className="settings-row">
      <div className="settings-row__label">
        <p className="settings-row__name">{label}</p>
        {description && <p className="settings-row__desc">{description}</p>}
      </div>
      <div className="settings-row__control">{children}</div>
    </div>
  );
}

function Settings() {
  return (
    <div className="settings-page">
      <div className="page-header">
        <div>
          <h2 className="page-title">Settings</h2>
          <p className="page-subtitle">Manage portal configuration and preferences.</p>
        </div>
      </div>

      <SettingsSection title="General">
        <SettingsRow label="Organization Name" description="The name shown in the portal header.">
          <input className="settings-input" type="text" defaultValue="Service Portal" />
        </SettingsRow>
        <SettingsRow label="Default Timezone" description="Used for timestamps and scheduling.">
          <select className="settings-select">
            <option>UTC-05:00 Eastern Time</option>
            <option>UTC-06:00 Central Time</option>
            <option>UTC-07:00 Mountain Time</option>
            <option>UTC-08:00 Pacific Time</option>
          </select>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Notifications">
        <SettingsRow label="Email Notifications" description="Send email alerts when cases are updated.">
          <label className="toggle">
            <input type="checkbox" defaultChecked />
            <span className="toggle__slider" />
          </label>
        </SettingsRow>
        <SettingsRow label="Case Assignment Alerts" description="Notify assignees when a case is assigned.">
          <label className="toggle">
            <input type="checkbox" defaultChecked />
            <span className="toggle__slider" />
          </label>
        </SettingsRow>
        <SettingsRow label="Digest Reports" description="Weekly summary of case activity via email.">
          <label className="toggle">
            <input type="checkbox" />
            <span className="toggle__slider" />
          </label>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Security">
        <SettingsRow label="Two-Factor Authentication" description="Require 2FA for all staff logins.">
          <label className="toggle">
            <input type="checkbox" />
            <span className="toggle__slider" />
          </label>
        </SettingsRow>
        <SettingsRow label="Session Timeout" description="Automatically log out after inactivity.">
          <select className="settings-select">
            <option>30 minutes</option>
            <option>1 hour</option>
            <option>4 hours</option>
            <option>8 hours</option>
          </select>
        </SettingsRow>
      </SettingsSection>

      <div className="settings-actions">
        <button className="btn btn--primary">Save Changes</button>
        <button className="btn btn--secondary">Cancel</button>
      </div>
    </div>
  );
}

export default Settings;
