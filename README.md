# Interviews App

Conversational AI app that qualifies Mark's network contacts against Neotoma ICP tiers and delivers personalized AI tool recommendations. Supports voice mode (via ElevenLabs) and text mode (via Anthropic Claude).

## Setup

This project uses a single **`.env`** file for local config. The API and Vite both read from it.

```bash
npm install
cp .env.example .env
# Fill in ANTHROPIC_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, ADMIN_PASSPHRASE,
# KV_REST_API_URL (https), KV_REST_API_TOKEN
```

To sync with Vercel (e.g. Redis REST URL): `vercel link` once, then `vercel env pull .env`. That overwrites `.env` with the project’s env vars, so keep required keys in the Vercel project. If you previously pulled into `.env.development.local`, copy its vars into `.env` and use `.env` only.

## Development

```bash
# starts Vite + local API server
npm run dev
```

This project uses Vercel serverless functions in production, but local development runs a lightweight Node API server on port 3000. Running plain `vite` will make chat fail with `/api` errors.

Voice mode requires an ElevenLabs Conversational AI agent. Run the setup script once:

```bash
export ELEVENLABS_API_KEY=your-key
./scripts/setup_elevenlabs_agent.sh
# Copy the agent_id to .env as ELEVENLABS_AGENT_ID
```

## Architecture

- **Frontend**: React + Vite + Tailwind, deployed as static site
- **API**: Vercel serverless functions (`/api/chat`, `/api/assess`, `/api/results`, `/api/contacts`, `/api/events`, `/api/invite`, `/api/admin`)
- **Voice**: ElevenLabs Conversational AI handles STT + Claude + TTS pipeline
- **Text**: Streaming chat via Anthropic API proxy
- **Assessment**: Post-conversation structured extraction via Claude

## Routes

- `/` — Landing page for interview entry points
- `/ai` — AI interview flow (welcome → conversation)
- `/ai/text` or `/ai/voice` — Active interview mode
- `/ai/thanks` — Confirmation / summary (bookmarkable; requires completed session in storage)
- `/ai/{contactCode}/thanks` — Same, with contact in path
- `/ai?c=CODE` — Personalized interview link with contact name/context
- `/ai/admin` — Results dashboard (passphrase-protected)

After a completed interview, the app replaces the URL with `/thanks`. **Start a new conversation** returns to the welcome screen and clears that session.

## Personalized links

Manage contact codes from the `/ai/admin` dashboard. Contacts are stored in shared
Vercel-backed storage and work across devices/browsers.

Send the link: `https://interview.markmhendrickson.com/ai?c=<contact-code>`

## Deploy

Hosted on Vercel. Push to `main` triggers deploy via GitHub Actions.

Required Vercel environment variables:
- `ANTHROPIC_API_KEY`
- `ELEVENLABS_API_KEY`
- `ELEVENLABS_AGENT_ID`
- `ADMIN_PASSPHRASE`
- `KV_REST_API_URL` — must be the **REST** endpoint (`https://...`). Do not use the `redis://` URL; the Upstash client requires HTTPS. In Vercel, connect the Redis integration to the project and use the injected `KV_REST_API_URL`. For local dev, copy the REST URL from the integration or Upstash dashboard.
- `KV_REST_API_TOKEN`
- `KV_KEY_PREFIX` (recommended when sharing one Redis DB between envs)
- `INTERVIEWS_ADMIN_NEOTOMA_SYNC_API_URL` (optional) — if set, `Sync now` pulls contacts from this HTTP endpoint instead of running local `neotoma` CLI. Useful for tunneling to a trusted local API while the app is deployed in prod.
- `INTERVIEWS_ADMIN_NEOTOMA_SYNC_API_TOKEN` (optional) — bearer token (or raw token for custom header) sent to sync API.
- `INTERVIEWS_ADMIN_NEOTOMA_SYNC_API_HEADER` (optional) — auth header name for sync API, defaults to `Authorization`.
- `INTERVIEWS_ADMIN_NEOTOMA_SYNC_API_METHOD` (optional) — HTTP method for sync API call. Default `GET`; use `POST` for Neotoma `/entities/query`.
- `INTERVIEWS_ADMIN_NEOTOMA_SYNC_API_TIMEOUT_MS` (optional) — HTTP timeout for sync calls, default `15000`.
- `INTERVIEWS_ADMIN_NEOTOMA_ENV` (optional) — used only by CLI sync path when `INTERVIEWS_ADMIN_NEOTOMA_SYNC_API_URL` is not set.
- `SENDGRID_API_KEY` (for invite email delivery)
- `SENDGRID_FROM_EMAIL` (sender email for invites)
- `SENDGRID_FROM_NAME` (sender display name for invites)
- `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` (for CI deploy)

Admin API auth:
- All `/api/admin` operations require `Authorization: Bearer <ADMIN_PASSPHRASE>`.
- `/api/admin` supports `resource=overview|results|contacts|events` via `GET`, contact upsert via `POST resource=contacts`, invite actions via `POST resource=invite`, and delete via `DELETE resource=results|contacts`.

Recommended key prefixes when using one free Redis DB:
- Preview/Development: `KV_KEY_PREFIX=development` (or `preview`)
- Production: `KV_KEY_PREFIX=production`
