<div align="center">

# 🔗 pi-umans-provider

**Coding-optimized models through [UMANS](https://code.umans.ai)**

_A [pi](https://github.com/earendil-works/pi-coding-agent) provider extension with reasoning, vision, and live plan status._

[![pi extension](https://img.shields.io/badge/pi-extension-blueviolet)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

</div>

---

## Features

- **OpenAI-compatible API** - Uses UMANS's `/v1/chat/completions` endpoint
- **Reasoning models** - DeepSeek-format thinking with `reasoning_content`
- **Vision models** - Image input on all models (GLM 5.1 via vision handoff)
- **Tool use** - Function calling support across all models
- **Streaming** - Real-time token streaming
- **Subscription-based** - All models included in your plan, no per-token cost
- **Usage status bar** — Displays your plan, concurrent sessions, and remaining requests in the pi footer

## Available Models

| Model | Base | Context | Vision | Reasoning | Max Output |
|-------|------|---------|--------|-----------|------------|
| Coder | Kimi K2.6 | 262K | ✅ | ✅ | 33K |
| Flash | Qwen3.6-35B-A3B | 262K | ✅ | ✅ | 33K |
| GLM 5.1 | GLM-5.1 | 203K | ✅* | ✅ | 131K |
| Kimi K2.6 | Kimi K2.6 | 262K | ✅ | ✅ | 33K |
| Qwen3.6 35B A3B | Qwen3.6-35B-A3B | 262K | ✅ | ✅ | 33K |

> \* GLM 5.1 vision uses a handoff pipeline: images are described by `umans-flash` at prompt time, then the text description replaces the image block for GLM.
>
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
- **`umans-glm-5.1`** — Reasoning model with large context window and vision via handoff

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

## API Compatibility

The UMANS API follows OpenAI conventions with these differences (handled via `patch.json` and `before_provider_request` hook):

| Aspect | OpenAI Native | UMANS |
|--------|-------------|-------|
| Thinking format | Varies | `deepseek` (`reasoning_content`) |
| Developer role | Varies | ❌ Not supported (use system role) |
| `reasoning_effort` | Varies | ⚠️ Stripped — upstream models don't support it |
| `requiresReasoningContentOnAssistantMessages` | — | ✅ Required — preserves thinking in history |
| Pricing | Per-token | Subscription-based ($0/M) |
| Vision (GLM 5.1) | Direct | ✅ via-handoff — `umans-flash` describes image at prompt time |

The extension also sanitizes orphaned `tool_calls` in conversation history. Context compaction can
drop tool result messages while keeping the assistant message that made the tool call, causing a
400 error from the API. The `before_provider_request` hook detects this and inserts synthetic tool results.

## Updating Models

To refresh the model list from the UMANS API:

```bash
npm run update-models
```

This fetches from `/v1/models/info`, updates `models.json`, and regenerates the README model table. Idempotent — safe to run repeatedly.

## API Documentation

- UMANS: https://code.umans.ai
- OpenAI-compatible endpoint: `https://api.code.umans.ai/v1`
- Models endpoint: `https://api.code.umans.ai/v1/models`
- Models info: `https://api.code.umans.ai/v1/models/info`
- Usage endpoint: `https://api.code.umans.ai/v1/usage`

## License

MIT
