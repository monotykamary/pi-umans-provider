<div align="center">

# 🔗 pi-umans-provider

**Coding-optimized models through [UMANS](https://code.umans.ai)**

_A [pi](https://github.com/earendil-works/pi-coding-agent) provider extension with reasoning, vision, and live plan status._

[![pi extension](https://img.shields.io/badge/pi-extension-blueviolet)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

</div>

---

## Features

- **Anthropic Messages-compatible API** - Uses UMANS's Anthropic Messages endpoint
- **Reasoning models** - DeepSeek-format thinking with `reasoning_content`
- **Vision models** - Image input on all models (including GLM 5.1 natively)
- **Tool use** - Function calling support across all models
- **Streaming** - Real-time token streaming
- **Subscription-based** - All models included in your plan, no per-token cost
- **Usage status bar** — Displays your plan, concurrent sessions, and remaining requests in the pi footer

## Available Models

| Model | Base | Context | Vision | Reasoning | Max Output |
|-------|------|---------|--------|-----------|------------|
| Coder | Kimi K2.6 | 262K | ✅ | ✅ | 33K |
| Flash | Qwen3.6-35B-A3B | 262K | ✅ | ✅ | 33K |
| GLM 5.1 | GLM-5.1 | 203K | ✅ | ✅ | 131K |
| Kimi K2.6 | Kimi K2.6 | 262K | ✅ | ✅ | 33K |
| Qwen3.6 35B A3B | Qwen3.6-35B-A3B | 262K | ✅ | ✅ | 33K |

> **Note:** `umans-flash-beta` is deprecated (sunset 2026-06-07). Use `umans-flash` instead.
> `umans-qwen3.6-35b-a3b` is a technical alias for `umans-flash`.

## Installation

### Option 1: Using `pi install` (Recommended)

Install directly from GitHub:

```bash
pi install https://github.com/monotykamary/pi-umans-provider
```

Then set your API key and run pi:
```bash
# Recommended: add to auth.json
# See Authentication section below

# Or set as environment variable
export UMANS_API_KEY=your-api-key-here

pi
```

Get your API key from [code.umans.ai](https://code.umans.ai).

### Option 2: Manual Clone

1. Clone this repository:
   ```bash
   git clone https://github.com/monotykamary/pi-umans-provider.git
   cd pi-umans-provider
   ```

2. Set your UMANS API key:
   ```bash
   # Recommended: add to auth.json
   # See Authentication section below

   # Or set as environment variable
   export UMANS_API_KEY=your-api-key-here
   ```

3. Run pi with the extension:
   ```bash
   pi -e /path/to/pi-umans-provider
   ```

### Option 3: `/login` (recommended — persists in auth.json)

In pi, run:

```
/login umans
```

Paste your API key when prompted. It's stored securely in `~/.pi/agent/auth.json` — no env vars needed.

## Authentication

The UMANS API key can be configured in multiple ways (resolved in this order):

1. **`auth.json`** (recommended) — Add to `~/.pi/agent/auth.json`:
   ```json
   { "umans": { "type": "api_key", "key": "your-api-key" } }
   ```
   The `key` field supports literal values, env var names, and shell commands (prefix with `!`). See [pi's auth file docs](https://github.com/badlogic/pi-mono) for details.
2. **Runtime override** — Use the `--api-key` CLI flag
3. **Environment variable** — Set `UMANS_API_KEY`

Get your API key from [code.umans.ai](https://code.umans.ai).

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `UMANS_API_KEY` | No | Your UMANS API key (fallback if not in auth.json) |

## Configuration

Add to your pi configuration for automatic loading:

```json
{
  "extensions": [
    "/path/to/pi-umans-provider"
  ]
}
```

## Usage

Once loaded, select a model with:

```
/model umans umans-coder
```

Or use `/models` to browse all available UMANS models.

### Recommended Models

- **`umans-coder`** — Best for complex, coding-heavy workloads. Optimized for coding agents.
- **`umans-flash`** — Fastest model for low-latency iteration with tools.
- **`umans-kimi-k2.6`** — Moonshot's native reasoning model with full vision support.
- **`umans-glm-5.1`** — Reasoning model with large context window and native vision support.

### Reasoning Effort

For reasoning models, control thinking depth:

```
/reasoning high
```

Values: `none`, `low`, `medium`, `high`

## Usage Status Bar

Once authenticated, the pi footer shows your UMANS account status:

```
Code Max (Founding Seat) | ⟠ 1/4
```

- **Plan name** — Your current subscription plan
- **`⟠ N/M`** — Active concurrent sessions / max concurrent sessions
- **`⇄ N`** — Remaining requests in the current window (shown when limited)

The status is fetched from UMANS's `/v1/usage` endpoint on session start and after each agent turn.

## Model Resolution: Stale-While-Revalidate

This extension uses a stale-while-revalidate strategy for model discovery:

1. **Serve stale immediately** — disk cache → embedded `models.json` (zero-latency startup)
2. **Revalidate in background** — live API `/v1/models/info` → merge with embedded → cache → hot-swap
3. **Apply patches** — `patch.json` + `custom-models.json` applied on top of whichever source won

Merge order: `[live|cache|embedded]` → apply `patch.json` → merge `custom-models.json`

New models added by Umans appear automatically — no extension update needed.

## API Compatibility

The UMANS API follows Anthropic Messages conventions. pi-ai's transform-messages layer handles message format translation, orphaned tool_use repair, and thinking content management automatically.

| Aspect | Behavior |
|--------|----------|
| API format | Anthropic Messages (`/v1/messages`) |
| Thinking format | DeepSeek (`reasoning_content`) |
| Developer role | ❌ Not supported (use system role) |
| Pricing | Subscription-based ($0/M) |
| Vision | ✅ All models including GLM 5.1 |

## Updating Models

To refresh the model list from the UMANS API:

```bash
npm run update-models
```

This fetches from `/v1/models/info`, updates `models.json`, and regenerates the README model table. Idempotent — safe to run repeatedly.

## API Documentation

- UMANS: https://code.umans.ai
- Anthropic Messages endpoint: `https://api.code.umans.ai/v1/messages`
- Models endpoint: `https://api.code.umans.ai/v1/models`
- Models info: `https://api.code.umans.ai/v1/models/info`
- Usage endpoint: `https://api.code.umans.ai/v1/usage`

## License

MIT
