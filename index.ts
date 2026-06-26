/**
 * UMANS Provider Extension
 *
 * Registers UMANS (code.umans.ai) as a custom provider using the
 * openai-completions API. Base URL: https://api.code.umans.ai/v1
 *
 * UMANS provides subscription-based access to coding-optimized models.
 * All models support tool use. Reasoning models use the DeepSeek thinking
 * format (thinking content in reasoning_content field).
 *
 * Key API details:
 *   - Uses `max_tokens` (NOT `max_completion_tokens`) — the latter is silently ignored
 *   - All reasoning models return `reasoning_content` in DeepSeek format
 *   - Developer role is NOT supported (use system role instead)
 *   - Subscription-based: $0 per-token cost
 *   - `umans-flash-beta` is deprecated (sunset 2026-06-07, use `umans-flash`)
 *   - `reasoning_effort` is NOT supported by upstream models — stripped in before_provider_request
 *
 * Model resolution strategy: Stale-While-Revalidate
 *   1. Serve stale immediately: disk cache → embedded models.json (zero-latency)
 *   2. Revalidate in background: live API /v1/models/info → merge with embedded → cache → hot-swap
 *   3. patch.json + custom-models.json applied on top of whichever source won
 *
 * Merge order: [live|cache|embedded] → apply patch.json → merge custom-models.json
 *
 * Usage:
 *   # Option 1: Store in auth.json (recommended)
 *   # Add to ~/.pi/agent/auth.json:
 *   #   "umans": { "type": "api_key", "key": "your-api-key" }
 *
 *   # Option 2: Set as environment variable
 *   export UMANS_API_KEY=your-api-key
 *
 *   # Run pi with the extension
 *   pi -e /path/to/pi-umans-provider
 *
 * @see https://code.umans.ai
 */

import type { ExtensionAPI, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import modelsData from "./models.json" with { type: "json" };
import customModelsData from "./custom-models.json" with { type: "json" };
import patchData from "./patch.json" with { type: "json" };
import fs from "fs";
import os from "os";
import path from "path";

// ─── Usage/Plan Types ────────────────────────────────────────────────────────

const USAGE_API_URL = "https://api.code.umans.ai/v1/usage";
const USAGE_FETCH_TIMEOUT_MS = 5000;
const USAGE_THROTTLE_MS = 30_000;

let sessionPlan: string | null = null;
let sessionConcurrency: number | null = null;
let sessionConcurrentSessions: number | null = null;
let sessionRequestsInWindow: number | null = null;
let sessionRemainingRequests: number | null = null;
let lastUsageFetchTime = 0;
let usageFetchInFlight = false;

interface OAuthCredentials {
  access: string;
  refresh: string;
  expires: number;
  [key: string]: unknown;
}

async function loginUmans(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const apiKey = await callbacks.onPrompt({
    message: "Enter your Umans API key (starts with sk-):",
  });
  const key = apiKey.trim();
  if (!key.startsWith("sk-")) {
    throw new Error("Invalid API key: must start with 'sk-'");
  }
  // API keys don't expire — use a far-future timestamp to prevent unnecessary refresh attempts
  return { refresh: key, access: key, expires: Date.now() + 100 * 365 * 24 * 60 * 60 * 1000 };
}

function refreshUmansToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  return Promise.resolve(credentials);
}

function getApiKey(credentials: OAuthCredentials): string {
  return credentials.access;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface JsonModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: Record<string, string | null>;
  compat?: {
    supportsDeveloperRole?: boolean;
    supportsStore?: boolean;
    maxTokensField?: "max_completion_tokens" | "max_tokens";
    thinkingFormat?: "openai" | "zai" | "qwen" | "qwen-chat-template" | "deepseek";
    supportsReasoningEffort?: boolean;
    requiresReasoningContentOnAssistantMessages?: boolean;
  };
}

interface PatchEntry {
  name?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevelMap?: Record<string, string | null>;
  compat?: Record<string, unknown>;
}

type PatchData = Record<string, PatchEntry>;

// Models returned by /v1/models/info
interface UmansModelInfo {
  name: string;
  display_name?: string;
  description?: string;
  base_model?: { name: string; provider?: string; oss_base?: string; family?: string };
  capabilities?: {
    max_completion_tokens?: number;
    recommended_max_tokens?: number;
    context_window?: number;
    supports_vision?: boolean | string;
    supports_tools?: boolean;
  };
  deprecation?: { sunset_date: string; replacement: string };
  benchmarks?: Record<string, unknown>;
}

type UmansModelsInfoResponse = Record<string, UmansModelInfo>;

// ─── Patch Application ────────────────────────────────────────────────────────

function applyPatch(model: JsonModel, patch: PatchEntry): JsonModel {
  const result = { ...model };

  if (patch.name !== undefined) result.name = patch.name;
  if (patch.reasoning !== undefined) result.reasoning = patch.reasoning;
  if (patch.input !== undefined) result.input = patch.input;
  if (patch.contextWindow !== undefined) result.contextWindow = patch.contextWindow;
  if (patch.maxTokens !== undefined) result.maxTokens = patch.maxTokens;
  if (patch.thinkingLevelMap !== undefined) result.thinkingLevelMap = { ...patch.thinkingLevelMap };

  if (patch.cost) {
    result.cost = {
      input: patch.cost.input ?? result.cost.input,
      output: patch.cost.output ?? result.cost.output,
      cacheRead: patch.cost.cacheRead ?? result.cost.cacheRead,
      cacheWrite: patch.cost.cacheWrite ?? result.cost.cacheWrite,
    };
  }
  if (patch.compat) {
    result.compat = { ...(result.compat || {}), ...patch.compat };
  }

  if (!result.reasoning && result.compat?.thinkingFormat) {
    delete result.compat.thinkingFormat;
  }
  if (result.compat && Object.keys(result.compat).length === 0) {
    delete result.compat;
  }

  return result;
}

/** Full pipeline: base models → patch → custom → result */
function buildModels(base: JsonModel[], custom: JsonModel[], patch: PatchData): JsonModel[] {
  const modelMap = new Map<string, JsonModel>();

  for (const model of base) {
    modelMap.set(model.id, model);
  }

  for (const [id, patchEntry] of Object.entries(patch)) {
    const existing = modelMap.get(id);
    if (existing) {
      modelMap.set(id, applyPatch(existing, patchEntry));
    }
  }

  for (const model of custom) {
    const existing = modelMap.get(model.id);
    const patchEntry = patch[model.id];
    if (existing && patchEntry) {
      modelMap.set(model.id, applyPatch(model, patchEntry));
    } else if (existing) {
      modelMap.set(model.id, model);
    } else if (patchEntry) {
      modelMap.set(model.id, applyPatch(model, patchEntry));
    } else {
      modelMap.set(model.id, model);
    }
  }

  return Array.from(modelMap.values());
}

// ─── Stale-While-Revalidate Model Sync ────────────────────────────────────────

const PROVIDER_ID = "umans";
const BASE_URL = "https://api.code.umans.ai/v1";
const MODELS_INFO_URL = `${BASE_URL}/models/info`;
const CACHE_DIR = path.join(os.homedir(), ".pi", "agent", "cache");
const CACHE_PATH = path.join(CACHE_DIR, `${PROVIDER_ID}-models.json`);
const LIVE_FETCH_TIMEOUT_MS = 8000;

const DEPRECATED_MODELS = new Set(["umans-flash-beta"]);

/** Transform a model from the UMANS /v1/models/info API. */
function transformApiModel(id: string, info: UmansModelInfo): JsonModel | null {
  if (info.deprecation || DEPRECATED_MODELS.has(id)) return null;

  const caps = info.capabilities || {};
  const hasVision = caps.supports_vision === true;

  return {
    id,
    name: info.display_name || info.name || id,
    reasoning: true,
    input: hasVision ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: caps.context_window || 131072,
    maxTokens: caps.recommended_max_tokens || caps.max_completion_tokens || 65000,
  };
}

async function fetchLiveModels(apiKey: string, signal?: AbortSignal): Promise<JsonModel[] | null> {
  try {
    const response = await fetch(MODELS_INFO_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: signal
        ? AbortSignal.any([AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS), signal])
        : AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as UmansModelsInfoResponse;
    if (!data || typeof data !== "object") return null;
    const models = Object.entries(data)
      .map(([id, info]) => transformApiModel(id, info))
      .filter((m): m is JsonModel => m !== null);
    if (models.length === 0) return null;
    return models;
  } catch {
    return null;
  }
}

function loadCachedModels(): JsonModel[] | null {
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

function cacheModels(models: JsonModel[]): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(models, null, 2) + "\n");
  } catch {
    // Cache write failure is non-fatal
  }
}

function mergeWithEmbedded(liveModels: JsonModel[], embeddedModels: JsonModel[]): JsonModel[] {
  const embeddedMap = new Map(embeddedModels.map((m) => [m.id, m]));
  const seen = new Set<string>();
  const result: JsonModel[] = [];
  for (const liveModel of liveModels) {
    const embedded = embeddedMap.get(liveModel.id);
    seen.add(liveModel.id);
    if (embedded) {
      result.push({
        ...liveModel,
        ...embedded,
        contextWindow: liveModel.contextWindow || embedded.contextWindow,
      });
    } else {
      result.push(liveModel);
    }
  }
  for (const em of embeddedModels) {
    if (!seen.has(em.id)) {
      result.push(em);
    }
  }
  return result;
}

function loadStaleModels(embeddedModels: JsonModel[]): JsonModel[] {
  const cached = loadCachedModels();
  if (!cached || cached.length === 0) return embeddedModels;

  const cachedMap = new Map(cached.map((m) => [m.id, m]));
  for (const em of embeddedModels) {
    if (!cachedMap.has(em.id)) {
      cached.push(em);
    }
  }
  return cached;
}

async function revalidateModels(
  apiKey: string | undefined,
  embeddedModels: JsonModel[],
  signal?: AbortSignal,
): Promise<JsonModel[] | null> {
  if (!apiKey) return null;
  const liveModels = await fetchLiveModels(apiKey, signal);
  if (!liveModels || liveModels.length === 0) return null;
  const merged = mergeWithEmbedded(liveModels, embeddedModels);
  cacheModels(merged);
  return merged;
}

// ─── API Key Resolution ────────────────────────────────────────────────────────

let cachedApiKey: string | undefined;
let revalidateAbort: AbortController | null = null;

async function resolveApiKey(modelRegistry: ModelRegistry): Promise<void> {
  cachedApiKey = (await modelRegistry.getApiKeyForProvider("umans")) ?? undefined;
}

// ─── Usage/Plan Footer ────────────────────────────────────────────────────────

interface UmansUsage {
  user_id?: string;
  plan: { slug: string; display_name: string };
  limits: {
    requests: { limit: number | null; window_seconds: number; description: string };
    concurrency: { limit: number; description: string };
  };
  usage: {
    requests_in_window: number;
    weighted_in_window?: number;
    remaining_requests: number | null;
    weighted_remaining_requests?: number | null;
    concurrent_sessions: number;
    weighted_concurrent_sessions?: number;
    tokens_in?: number;
    tokens_out?: number;
    tokens_cached?: number;
  };
  window?: {
    started_at?: string;
    resets_at?: string;
    remaining_minutes?: number;
  };
}

async function fetchUsage(
  apiKey: string | undefined,
  signal?: AbortSignal,
): Promise<UmansUsage | null> {
  if (!apiKey) return null;
  try {
    const response = await fetch(USAGE_API_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: signal
        ? AbortSignal.any([AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS), signal])
        : AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as UmansUsage;
    if (!data.plan?.slug) return null;
    return data;
  } catch {
    return null;
  }
}

function applyUsage(usage: UmansUsage, ctx: any): void {
  sessionPlan = usage.plan.display_name;
  sessionConcurrency = usage.limits?.concurrency?.limit ?? null;
  sessionConcurrentSessions = usage.usage.concurrent_sessions ?? null;
  sessionRequestsInWindow = usage.usage.requests_in_window ?? null;
  sessionRemainingRequests = usage.usage.remaining_requests ?? null;
  updateUsageStatus(ctx);
}

// Throttled fetch — skips if one is in flight or if the last successful fetch
// was within USAGE_THROTTLE_MS. Returns null on skip, caller checks.
async function throttledFetchUsage(
  apiKey: string | undefined,
  options?: { force?: boolean; signal?: AbortSignal },
): Promise<UmansUsage | null> {
  const now = Date.now();
  const { force = false, signal } = options ?? {};
  if (!force && (usageFetchInFlight || now - lastUsageFetchTime < USAGE_THROTTLE_MS)) {
    return null;
  }
  usageFetchInFlight = true;
  try {
    const usage = await fetchUsage(apiKey, signal);
    if (usage) {
      lastUsageFetchTime = now;
    }
    return usage;
  } finally {
    usageFetchInFlight = false;
  }
}

function updateUsageStatus(ctx: any): void {
  if (ctx.model?.provider !== "umans") {
    ctx.ui.setStatus("umans-usage", undefined);
    return;
  }
  if (!sessionPlan) {
    ctx.ui.setStatus("umans-usage", undefined);
    return;
  }
  const parts: string[] = [sessionPlan];
  if (sessionConcurrency != null) {
    parts.push(`\u27e0 ${(sessionConcurrentSessions ?? 0)}/${sessionConcurrency}`);
  }
  if (sessionRemainingRequests != null) {
    parts.push(`\u21c4 ${sessionRemainingRequests}`);
  }
  ctx.ui.setStatus("umans-usage", ctx.ui.theme.fg("dim", parts.join(" | ")));
}

function clearUsageStatus(ctx: any): void {
  sessionPlan = null;
  sessionConcurrency = null;
  sessionConcurrentSessions = null;
  sessionRequestsInWindow = null;
  sessionRemainingRequests = null;
  ctx.ui.setStatus("umans-usage", undefined);
}

// ─── Extension Entry Point ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const embeddedModels = modelsData as JsonModel[];
  const customModels = customModelsData as JsonModel[];
  const patches = patchData as PatchData;

  const staleBase = loadStaleModels(embeddedModels);
  const staleModels = buildModels(staleBase, customModels, patches);

  pi.registerProvider("umans", {
    baseUrl: BASE_URL,
    apiKey: "$UMANS_API_KEY",
    api: "openai-completions",
    models: staleModels,
    oauth: {
      name: "Umans AI (API Key)",
      login: loginUmans,
      refreshToken: refreshUmansToken,
      getApiKey: getApiKey,
    },
  });

  function isUmansModel(ctx: any): boolean {
    return ctx.model?.provider === "umans";
  }

  pi.on("before_provider_request", async (event) => {
    const p = event.payload as Record<string, any>;
    const model: string = p.model ?? "";
    if (!model.startsWith("umans-")) return;

    if ("reasoning_effort" in p) {
      const { reasoning_effort: _, ...rest } = p as any;
      Object.assign(p, rest);
      delete (p as any).reasoning_effort;
    }

    const messages = p.messages;
    if (!Array.isArray(messages) || messages.length === 0) return;

    const toolCallIds = new Set<string>();
    for (const msg of messages) {
      if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (tc.id) toolCallIds.add(tc.id);
        }
      }
    }

    const toolResultIds = new Set<string>();
    for (const msg of messages) {
      if (msg.role === "tool" && msg.tool_call_id) {
        toolResultIds.add(msg.tool_call_id);
      }
    }

    const orphanedIds = [...toolCallIds].filter((id) => !toolResultIds.has(id));
    if (orphanedIds.length === 0) return;

    const newMessages = [...messages];
    let insertOffset = 0;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== "assistant" || !Array.isArray(msg.tool_calls)) continue;

      const orphanedCalls = msg.tool_calls.filter((tc: any) =>
        orphanedIds.includes(tc.id),
      );
      if (orphanedCalls.length === 0) continue;

      const insertIdx = i + insertOffset + 1;
      const syntheticResults = orphanedCalls.map((tc: any) => ({
        role: "tool",
        tool_call_id: tc.id,
        content: "[tool result was lost during context compaction]",
      }));

      newMessages.splice(insertIdx, 0, ...syntheticResults);
      insertOffset += orphanedCalls.length;
    }

    p.messages = newMessages;
    return p;
  });

  pi.on("session_start", async (_event, ctx) => {
    revalidateAbort?.abort();
    revalidateAbort = new AbortController();
    const signal = revalidateAbort.signal;
    resolveApiKey(ctx.modelRegistry).then(async () => {
      revalidateModels(cachedApiKey, embeddedModels, signal).then((freshBase) => {
        if (freshBase && !signal.aborted) {
          pi.registerProvider("umans", {
            baseUrl: BASE_URL,
            apiKey: "$UMANS_API_KEY",
            api: "openai-completions",
            models: buildModels(freshBase, customModels, patches),
          });
        }
      });

      if (!isUmansModel(ctx)) {
        clearUsageStatus(ctx);
        return;
      }

      const usage = await throttledFetchUsage(cachedApiKey, { force: true, signal });
      if (usage && !signal.aborted) {
        applyUsage(usage, ctx);
      }
    });
  });

  pi.on("model_select", (event, ctx) => {
    if (event.model?.provider === "umans") {
      throttledFetchUsage(cachedApiKey, { force: true }).then((usage) => {
        if (usage) {
          applyUsage(usage, ctx);
        } else {
          updateUsageStatus(ctx);
        }
      });
    } else {
      clearUsageStatus(ctx);
    }
  });

  // The server only reports concurrent_sessions > 0 while a provider request
  // is actively streaming. message_start fires once per assistant message
  // when streaming begins — the exact moment the server counts the session.
  pi.on("message_start", async (event, ctx) => {
    if (event.message?.role !== "assistant") return;
    if (!isUmansModel(ctx)) return;
    // Brief delay so the server has time to register the active session
    // before we query its count.
    await new Promise((r) => setTimeout(r, 2000));
    const usage = await throttledFetchUsage(cachedApiKey, { force: true });
    if (usage) {
      applyUsage(usage, ctx);
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    updateUsageStatus(ctx);
  });

  pi.on("session_shutdown", () => {
    revalidateAbort?.abort();
  });
}
