# BarOps Live Dashboard

Next.js dashboard for night trade projection, wage trend, and realtime integrations.

## Local setup

1. Install deps:
```bash
npm install
```
2. Copy env template and fill secrets:
```bash
cp .env.example .env.local
```
3. Start dev server:
```bash
npm run dev
```

## Required realtime environment variables

- `SQUARE_ACCESS_TOKEN`
- `SQUARE_LOCATION_ID`
- `DEPUTY_ACCESS_TOKEN`
- `DEPUTY_BASE_URL`
- `SQUARE_ENVIRONMENT` (optional, `production` default, `sandbox` supported)

These values are server-side only. The app does not store these secrets in browser storage.

## Deploy to Vercel

1. Push repo to GitHub.
2. In Vercel, import the GitHub repo.
3. In Project Settings -> Environment Variables, add the variables listed above.
4. Redeploy.

## Scripts

- `npm run dev` - development server
- `npm run lint` - eslint
- `npm run build` - production build check
