# 🍷 Wine Digest — Automated Weekly Email Service

A self-hosted backend that searches Vivino and Wine-Searcher every week for top-rated and trending wines, then emails a beautiful HTML digest to your subscribers automatically.

---

## How it works

1. A **cron job** fires every day at 08:00 (your timezone)
2. It checks which subscribers have scheduled their digest for today
3. For each subscriber it calls the **Anthropic API** (with live web search) to fetch top-rated and rising-star wines matching their filters
4. It builds a rich **HTML email** and sends it via Gmail

---

## Setup

### 1. Clone and install

```bash
git clone <your-repo>
cd wine-digest
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
ANTHROPIC_API_KEY=sk-ant-...
GMAIL_USER=you@gmail.com
GMAIL_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
TIMEZONE=Europe/Copenhagen
PORT=3000
```

**Getting a Gmail App Password:**
1. Enable 2FA on your Google account
2. Go to https://myaccount.google.com/apppasswords
3. Create a new app password → copy the 16-character code

### 3. Run

```bash
npm start          # production
npm run dev        # development (auto-restarts on changes)
```

---

## API Reference

### Subscribe to weekly digest

```http
POST /api/digests
Content-Type: application/json

{
  "email": "you@email.com",
  "sendDay": "Thursday",
  "wineType": "Red",
  "maxPrice": 300,
  "currency": "DKK",
  "region": "France",
  "includeTop": true,
  "includeRising": true
}
```

`sendDay` options: `Monday` `Tuesday` `Wednesday` `Thursday` `Friday` `Saturday` `Sunday`

### List all subscriptions

```http
GET /api/digests
```

### Send a digest immediately

```http
POST /api/digests/:id/send
```

### Send a one-off preview

```http
POST /api/send-preview
Content-Type: application/json

{
  "email": "you@email.com",
  "wineType": "any",
  "maxPrice": 500,
  "currency": "DKK",
  "includeTop": true,
  "includeRising": true
}
```

### Unsubscribe

```http
DELETE /api/digests/:id
```

### Health check

```http
GET /api/health
```

---

## Deployment options

### Option A — Run locally (simplest)

Just keep `npm start` running on your machine. The cron fires at 08:00 every day.

### Option B — Railway (recommended, free tier)

1. Push to a GitHub repo
2. Go to https://railway.app → New Project → Deploy from GitHub
3. Add environment variables in the Railway dashboard
4. Done — Railway keeps it running 24/7

### Option C — Render

1. Push to GitHub
2. https://render.com → New Web Service
3. Build command: `npm install`
4. Start command: `npm start`
5. Add environment variables

### Option D — VPS / server

```bash
npm install -g pm2
pm2 start server.js --name wine-digest
pm2 save
pm2 startup
```

### Option E — Docker

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
```

```bash
docker build -t wine-digest .
docker run -d --env-file .env -p 3000:3000 wine-digest
```

---

## Data storage

Subscribers are stored in `digests.json` (auto-created). For production with multiple instances, swap this for a database — the `loadDigests()` / `saveDigests()` functions are the only two places to change.

---

## Connecting to the web app

In the Wine Discovery web app, replace the Anthropic API calls for email sending with calls to your backend:

```js
// Save digest schedule
await fetch('http://localhost:3000/api/digests', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, sendDay, wineType, maxPrice, currency, region })
});

// Send preview now
await fetch('http://localhost:3000/api/send-preview', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, wineType, maxPrice, currency, region })
});
```
