# Service Portal — Setup Guide

This guide helps you set up your own Service Org Portal. All configuration is externalized — nothing is hardcoded.

---

## Core Principles

1. **No Hardcoded Values** — All org-specific values are configured via environment variables or JSON files
2. **Secrets Never in Code** — OAuth secrets and tokens are stored in environment variables
3. **Modular Architecture** — Auth, wiki, and service tracking can be customized independently
4. **Data-Driven UI** — Service cards, staff members, and office hours are loaded from `data/services.json`

---

## Required Configuration

### 1. Environment Variables

Copy `.env.example` to `.env` and fill in your values:

| Variable | Description | Example |
|----------|-------------|---------|
| `BASE_URL` | Your deployed app URL | `https://your-app.run.app` |
| `GOOGLE_CLIENT_ID` | OAuth 2.0 Client ID | `123456789.apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | OAuth 2.0 Client Secret | (from Google Cloud Console) |
| `ALLOWED_DOMAIN` | Email domain for access control | `yourcompany.com` |
| `SESSION_SECRET` | Random string for session signing | run: `openssl rand -hex 32` |
| `GITHUB_TOKEN` | PAT for auto-sync commits (optional) | (from GitHub Settings → Developer Settings) |
| `PORT` | Server port | `8080` |

### 2. Google Cloud Setup

#### Project Configuration
```
PROJECT_ID=your-project-id
REGION=us-central1
```

#### Required APIs to enable
- Cloud Run API
- Secret Manager API (optional, for storing secrets)
- Artifact Registry API (for Docker images)

#### Service Account
Create a service account for Cloud Run with these roles:
- `roles/run.invoker`
- `roles/secretmanager.secretAccessor` (if using Secret Manager)

### 3. Data Files to Customize

#### `data/services.json`
Define your services, staff, and office hours:

```json
{
  "services": [
    {
      "id": "your-service-id",
      "name": "Your Service Name",
      "description": "Service description",
      "owner": "staff-id",
      "status": "active"
    }
  ],
  "staff": [
    {
      "id": "staff-id",
      "name": "Full Name",
      "role": "Role Title",
      "dept": "Department",
      "email": "email@yourcompany.com",
      "status": "Available",
      "services": ["your-service-id"]
    }
  ],
  "officeHours": [
    {
      "serviceId": "your-service-id",
      "day": "Monday",
      "time": "9:00 AM",
      "timezone": "EST"
    }
  ]
}
```

#### `services-updates/{service-id}/status.md`
Create a weekly status file for each service. Use the template at `services-updates/templates/STATUS-TEMPLATE.md`.

---

## Deployment Steps

### Step 1: Clone and Configure

```bash
git clone https://github.com/kalashivali-dev/service-portal.git
cd service-portal
cp .env.example .env
# Edit .env with your values
```

### Step 2: Set Up Google OAuth

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project or select existing
3. Navigate to **APIs & Services → Credentials**
4. Create **OAuth 2.0 Client ID** (Web application)
5. Add authorized redirect URI: `https://your-app.run.app/oauth2/callback`
6. Copy the Client ID and Client Secret into your `.env`

### Step 3: Run Locally

```bash
npm install
npm start
# Open http://localhost:8080
```

### Step 4: Deploy to Cloud Run

```bash
gcloud run deploy service-portal \
  --source=. \
  --region=us-central1 \
  --allow-unauthenticated \
  --set-env-vars="BASE_URL=https://your-app.run.app" \
  --set-env-vars="GOOGLE_CLIENT_ID=your-client-id" \
  --set-env-vars="GOOGLE_CLIENT_SECRET=your-secret" \
  --set-env-vars="ALLOWED_DOMAIN=yourcompany.com" \
  --set-env-vars="SESSION_SECRET=$(openssl rand -hex 32)"
```

### Step 5: Set Up CI/CD (GitHub Actions)

Update `.github/workflows/deploy.yml` with your values:
- `YOUR_PROJECT_ID` → your GCP project ID
- `SERVICE_NAME` → `service-portal` (or your preferred name)
- Add GitHub secrets: `WORKLOAD_IDENTITY_PROVIDER`, `SERVICE_ACCOUNT`

---

## Customization Points

### Branding
- `index.html` — Change org name, colors, logo
- CSS custom properties at the top of `<style>` in `index.html`

### Services
- `data/services.json` — Add/remove services and staff
- `services-updates/{id}/status.md` — Weekly status per service
- `wiki/services/{id}.md` — Wiki page per service

### Staff / People
- `data/services.json` → `staff` array
- `wiki/people/{name}.md` — Individual staff wiki pages

### Wiki Structure
- Add markdown files anywhere under `wiki/`
- Update `wiki/index.md` to list them

---

## File Structure

```
service-portal/
├── index.html                    # Main portal UI (customize branding)
├── server.js                     # Node.js server (customize auth domain)
├── Dockerfile                    # Container config
├── data/
│   └── services.json             # YOUR services, staff, office hours
├── services-updates/
│   ├── templates/                # Status file templates
│   └── {service-id}/             # Weekly status files per service
├── wiki/
│   ├── index.md                  # Wiki catalog
│   ├── services/                 # Service wiki pages
│   ├── people/                   # Staff member pages
│   └── trackers/                 # Action items, risks
└── .github/
    └── workflows/
        └── deploy.yml            # CI/CD to Cloud Run
```

---

## Security Checklist

Before deploying, ensure:

- [ ] `ALLOWED_DOMAIN` is set to your company domain
- [ ] OAuth credentials are in environment variables, not in code
- [ ] `SESSION_SECRET` is a strong random string (`openssl rand -hex 32`)
- [ ] No `.env` file committed to repository (it's in `.gitignore`)
- [ ] Cloud Run service has appropriate IAM policies

---

## Troubleshooting

### OAuth Login Fails
- Verify `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are correct
- Check redirect URI in Google Console matches exactly: `{BASE_URL}/oauth2/callback`
- Ensure `ALLOWED_DOMAIN` matches your email domain

### Wiki Pages Not Loading
- Check the markdown file exists under `wiki/`
- Verify the filename matches what the frontend is requesting
- Check browser console for 404 errors

### Services Not Showing
- Validate `data/services.json` is valid JSON
- Verify the file is copied in `Dockerfile`
- Check browser console for API errors
