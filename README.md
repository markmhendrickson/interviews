# Network Survey App

Conversational AI app that qualifies Mark's network contacts against Neotoma ICP tiers and delivers personalized AI tool recommendations. Supports voice mode (via ElevenLabs) and text mode (via Anthropic Claude).

## Setup

```bash
npm install
cp .env.example .env.local
# Fill in ANTHROPIC_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, ADMIN_PASSPHRASE
```

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
# Copy the agent_id to .env.local as ELEVENLABS_AGENT_ID
```

## Architecture

- **Frontend**: React + Vite + Tailwind, deployed as static site
- **API**: Vercel serverless functions (`/api/chat`, `/api/assess`, `/api/results`)
- **Voice**: ElevenLabs Conversational AI handles STT + Claude + TTS pipeline
- **Text**: Streaming chat via Anthropic API proxy
- **Assessment**: Post-conversation structured extraction via Claude

## Routes

- `/` — Interview flow (welcome -> conversation -> recommendations)
- `/?c=CODE` — Personalized entry with contact name/context from `contacts.json`
- `/admin` — Results dashboard (passphrase-protected)

## Personalized links

Edit `src/data/contacts.json` to add contacts:

```json
{
  "abc123": {
    "name": "Sarah",
    "context": "building agent infrastructure at Acme Corp",
    "source": "linkedin"
  }
}
```

Send the link: `https://your-domain.vercel.app/?c=abc123`

## Deploy

Hosted on Vercel. Push to `main` triggers deploy via GitHub Actions.

Required Vercel environment variables:
- `ANTHROPIC_API_KEY`
- `ELEVENLABS_API_KEY`
- `ELEVENLABS_AGENT_ID`
- `ADMIN_PASSPHRASE`
- `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` (for CI deploy)
