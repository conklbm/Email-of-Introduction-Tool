# Email of Introduction

Paste two LinkedIn profile URLs → get a bullet list of what the two people have in common, plus three ready-to-send intro emails (warm, professional, brief).

## How it works

1. **Scrape** — both profiles are fetched in parallel with the Apify actor [`harvestapi/linkedin-profile-scraper`](https://console.apify.com/actors/LpVuK3Zozwuipa5bp) (no LinkedIn cookies or account needed).
2. **Analyze & write** — the trimmed profiles go to **Claude Haiku 4.5** (Anthropic's low-cost model, ~1–2¢ per run), which returns similarities + three drafts as validated JSON.
3. **Display** — the UI shows the common ground and three tabbed email drafts with copy buttons.

Keys never touch the browser — all API calls happen server-side.

## Structure

```
├── public/index.html   # UI (served statically)
├── api/generate.js     # Vercel serverless function
├── lib/intro.js        # Shared logic: scrape, trim, Claude call
├── server.js           # Local dev server (Express wrapper around lib/)
└── vercel.json         # maxDuration 300s for the scrape
```

## Local setup

```bash
npm install
copy .env.example .env   # then fill in both keys
npm start                # http://localhost:3000
```

Required in `.env`:

| Var | Where to get it |
|---|---|
| `APIFY_TOKEN` | [console.apify.com](https://console.apify.com/settings/integrations) → Settings → API & Integrations |
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com/settings/keys) → API Keys |

## Deploy to Vercel

```bash
npx vercel          # first deploy — accept defaults ("Other" framework)
npx vercel --prod
```

Or push to GitHub and import the repo at [vercel.com/new](https://vercel.com/new).

Then in the Vercel project settings:

1. **Environment Variables** — add `APIFY_TOKEN` and `ANTHROPIC_API_KEY` (Production + Preview).
2. **Fluid compute** — leave enabled (default). It allows the 300s `maxDuration` in `vercel.json`, needed for the 30–90s profile scrapes.

## Costs per intro

- Apify harvestapi scraper: ~$0.008 (2 profiles at ~$4/1k)
- Claude Haiku 4.5: ~$0.01–0.02

## Notes

- Profile scrapes take 30–90 seconds — the UI shows staged progress.
- Basic per-IP rate limit: 10 generations / 10 minutes.
- Nothing is stored server-side.
