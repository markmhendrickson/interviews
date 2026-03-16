#!/usr/bin/env bash
# Creates or updates the ElevenLabs Conversational AI agent.
#
# Prerequisites:
#   - ELEVENLABS_API_KEY environment variable set
#   - ELEVENLABS_AGENT_ID set (for update) or empty (for create)
#   - jq installed
#
# Usage:
#   ./scripts/setup_elevenlabs_agent.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Load env files if present (without overriding already-exported vars).
set -a
if [ -f "$PROJECT_DIR/.env.local" ]; then
  source "$PROJECT_DIR/.env.local"
fi
if [ -f "$PROJECT_DIR/.env" ]; then
  source "$PROJECT_DIR/.env"
fi
set +a

if [ -z "${ELEVENLABS_API_KEY:-}" ]; then
  echo "Error: ELEVENLABS_API_KEY is not set (checked shell env, .env.local, and .env)"
  exit 1
fi

if ! command -v jq &> /dev/null; then
  echo "Error: jq is required. Install with: brew install jq"
  exit 1
fi

SYSTEM_PROMPT=$(cat <<'PROMPT_EOF'
You are an AI interviewer working on behalf of Mark Hendrickson. You are conducting a conversational interview with one of Mark's network contacts via voice.

Your job has two purposes:
1. Qualify the contact against Neotoma's target ICP profiles and mine referrals.
2. Give every participant personalized, genuinely useful recommendations for leveling up their AI usage.

Keep responses conversational and concise — you are speaking, not writing. Use short sentences. Pause naturally. Match the contact's energy.

## About Neotoma
Mark is building Neotoma — a deterministic state layer for persistent AI agent memory. It's infrastructure that governs how agent state evolves over time with versioned history, replayable timelines, and schema constraints. Not an "AI memory tool."

## ICP Tier 1 Targets
- AI Infrastructure Engineers: Build agent runtimes, orchestration, observability. Pain: can't reproduce agent runs, invisible state mutations.
- Agent System Builders: Ship multi-step agents with tool calling. Pain: drift across sessions, conflicting facts.
- AI-native Operators: 3+ AI tools daily, automation habits. Pain: context fragmentation, repeated explanations.

## Anti-ICP Signals
- Looking for a note-taking/PKM app
- No agent workflows
- Expects zero-install onboarding
- "AI remembering things" without caring about determinism

## Interview Protocol (5 phases, 5-8 exchanges total)
Phase 1: Warm opener — greet by name if known, ask what they do and how AI fits in.
Phase 2: AI usage depth — what tools, how often, what pain points.
Phase 3: ICP qualification — probe deeper based on signals from Phase 2.
Phase 4: Referral mining — who do they know who builds with AI agents.
Phase 5: Recommendations — personalized tool recs. Neotoma ONLY for ICP matches.

## Rules
- One question at a time
- React before asking the next question
- Keep responses to 2-3 sentences when asking questions
- Be transparent: you're AI working on Mark's behalf
- Signal when you're wrapping up: "Just one more thing..."

## Dynamic Variables
Contact name: {{contact_name}}
Contact context: {{contact_context}}
PROMPT_EOF
)

FIRST_MESSAGE="Hi! Thanks for taking the time to chat. Mark mentioned he wanted me to learn a bit about how AI fits into your life. I have some personalized recommendations at the end too. So — what do you do, and where does AI come in for you?"

AGENT_PAYLOAD=$(jq -n \
  --arg prompt "$SYSTEM_PROMPT" \
  --arg first_message "$FIRST_MESSAGE" \
  '{
    "name": "Network Survey Interviewer",
    "conversation_config": {
      "agent": {
        "prompt": {
          "prompt": $prompt,
          "llm": "gpt-4-turbo",
          "temperature": 0.7
        },
        "first_message": $first_message,
        "language": "en"
      },
      "turn": {
        "turn_timeout": 10
      },
      "conversation": {
        "max_duration_seconds": 600
      },
      "tts": {
        "model_id": "eleven_flash_v2",
        "voice_id": "JBFqnCBsd6RMkjVDRZzb"
      }
    },
    "platform_settings": {
      "conversation_initiation_client_data": {
        "conversation_config_override": {
          "agent": {
            "first_message": true,
            "language": true
          }
        }
      }
    }
  }')

EXISTING_AGENT_ID="${ELEVENLABS_AGENT_ID:-}"

if [ -n "$EXISTING_AGENT_ID" ]; then
  echo "Updating existing ElevenLabs agent: $EXISTING_AGENT_ID ..."

  RESPONSE=$(curl -s -X PATCH \
    "https://api.elevenlabs.io/v1/convai/agents/${EXISTING_AGENT_ID}" \
    -H "xi-api-key: ${ELEVENLABS_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "$AGENT_PAYLOAD")

  AGENT_ID=$(echo "$RESPONSE" | jq -r '.agent_id // empty')

  if [ -z "$AGENT_ID" ]; then
    echo "Error updating agent:"
    echo "$RESPONSE" | jq .
    exit 1
  fi

  echo ""
  echo "Agent updated successfully!"
  echo "Agent ID: $AGENT_ID"
  echo ""
  echo "Restart npm run dev and test voice mode."
else
  echo "Creating new ElevenLabs Conversational AI agent..."

  RESPONSE=$(curl -s -X POST "https://api.elevenlabs.io/v1/convai/agents/create" \
    -H "xi-api-key: ${ELEVENLABS_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "$AGENT_PAYLOAD")

  AGENT_ID=$(echo "$RESPONSE" | jq -r '.agent_id // empty')

  if [ -z "$AGENT_ID" ]; then
    echo "Error creating agent:"
    echo "$RESPONSE" | jq .
    exit 1
  fi

  echo ""
  echo "Agent created successfully!"
  echo "Agent ID: $AGENT_ID"
  echo ""
  echo "Next steps:"
  echo "  1. Add to .env:  ELEVENLABS_AGENT_ID=$AGENT_ID"
  echo "  2. Add to Vercel env:  ELEVENLABS_AGENT_ID=$AGENT_ID"
  echo "  3. Restart npm run dev and test voice mode"
fi
