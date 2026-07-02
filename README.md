# verity-api

A tiny, **chain-independent** claim-validation service for [Verity](../verity).
It is a thin proxy to [Groq](https://groq.com) that performs the one check a
regex can't: judging whether a candidate claim is a single **atomic** assertion
(and decomposing it if not), plus basic well-formed / verifiable checks.

It is deliberately separate from the main `app` backend because these checks
depend on **no chain state** — only the claim text. Chain-dependent checks
(duplicate detection against on-chain claims, staking, relaying) stay in `app`.

## Why a proxy (not called directly from the extension)?
The Groq API key must never ship in client code. This service holds the key and
forwards requests; the heavy lifting is on Groq, so this stays cheap to run.

## Endpoints

### `GET /health`
Liveness + whether the Groq key is configured.

### `POST /atomicity`
```jsonc
// request
{ "text": "Miners collect transaction fees and a fixed reward." }

// response
{
  "atomic": true,
  "subClaims": ["Miners collect transaction fees and a fixed reward."],
  "wellFormed": true,
  "verifiable": true,
  "reason": "Single assertion about what miners collect."
}
```
Returns `503` if `GROQ_API_KEY` is unset (so the client can fall back to local
heuristics), `400` for bad input, `502` on an upstream LLM error.

## Run

```bash
cp .env.example .env   # then set GROQ_API_KEY
npm install
npm run dev            # tsx watch, hot reload
# or
npm run build && npm start
```

## Config (`.env`)
| Var | Default | Notes |
|-----|---------|-------|
| `GROQ_API_KEY` | — | required; from console.groq.com/keys |
| `GROQ_MODEL` | `llama-3.3-70b-versatile` | `llama-3.1-8b-instant` for speed |
| `PORT` | `8790` | |
| `ALLOW_ORIGIN` | `*` | comma-separated origins in prod |
