# Luna Proxy Integration

FreeLLM treats Luna Proxy as a managed sidecar provider named `luna`. Luna owns
Qwen web-chat credentials, sessions, overflow files, tool-call bridging, and
multi-account routing. FreeLLM keeps the unified API key, fallback chain,
OpenAI/Anthropic facades, analytics, and dashboard.

## Local Run

```bash
npm run luna:setup
npm run dev:with-luna
```

Open Luna at `http://127.0.0.1:8080/`, configure Qwen credentials there, then
open FreeLLM and add a provider key for platform `luna`.

Use Luna's `proxy.key` if configured. If Luna has no proxy key, use any
non-empty placeholder such as `local-placeholder`; FreeLLM needs one key row so
the router can include Luna in the fallback chain.

## Configuration

```env
LUNA_PROXY_BASE_URL=http://127.0.0.1:8080/v1
LUNA_PROXY_TIMEOUT_MS=300000
```

For Vercel or any remote FreeLLM deployment, `127.0.0.1` points at the Vercel
function, not your PC. Run Luna on a reachable private/public URL and set
`LUNA_PROXY_BASE_URL` to that URL ending in `/v1`.

## Models

FreeLLM seeds these Luna-backed Qwen model IDs:

- `qwen-latest-series-invite-beta-v24`
- `qwen3.6-max-preview`
- `qwen3-coder-plus`
- `qwen3.6-plus`
- `qwen3.5-flash`

Convenience aliases:

- `qwen-luna`
- `qwen3.7-max-preview`
- `qwen3-coder-luna`
