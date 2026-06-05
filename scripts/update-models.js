#!/usr/bin/env node
/**
 * Update UMANS models from API
 *
 * Fetches models from https://api.code.umans.ai/v1/models/info and updates:
 * - models.json: Pure API model definitions (no patches baked in)
 * - README.md: Model table with patch.json overrides applied
 *
 * models.json reflects the raw API data as-is. patch.json corrects
 * compatibility details at runtime (index.ts) and is also applied when
 * generating the README table so the docs reflect reality.
 *
 * Idempotent: re-running produces the same result if the API hasn't changed.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MODELS_INFO_API_URL = "https://api.code.umans.ai/v1/models/info";
const MODELS_JSON_PATH = path.join(__dirname, "..", "models.json");
const PATCH_JSON_PATH = path.join(__dirname, "..", "patch.json");
const CUSTOM_MODELS_JSON_PATH = path.join(__dirname, "..", "custom-models.json");
const README_PATH = path.join(__dirname, "..", "README.md");

// Skip deprecated aliases
const DEPRECATED_MODELS = new Set(["umans-flash-beta"]);

function transformApiModel(id, info) {
  if (info.deprecation || DEPRECATED_MODELS.has(id)) return null;

  const caps = info.capabilities || {};
  const hasVision = caps.supports_vision === true || caps.supports_vision === "via-handoff";

  return {
    id,
    name: info.display_name || info.name || id,
    reasoning: true, // All UMANS models are reasoning-capable
    input: hasVision ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, // Subscription-based
    contextWindow: caps.context_window || 131072,
    maxTokens: caps.recommended_max_tokens || caps.max_completion_tokens || 131072,
  };
}

function applyPatch(model, patch) {
  const result = { ...model };
  if (patch.name !== undefined) result.name = patch.name;
  if (patch.reasoning !== undefined) result.reasoning = patch.reasoning;
  if (patch.input !== undefined) result.input = patch.input;
  if (patch.contextWindow !== undefined) result.contextWindow = patch.contextWindow;
  if (patch.maxTokens !== undefined) result.maxTokens = patch.maxTokens;
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

function buildModels(baseModels, customModels, patchData) {
  const modelMap = new Map();
  for (const model of baseModels) {
    modelMap.set(model.id, model);
  }
  for (const [id, patchEntry] of Object.entries(patchData)) {
    const existing = modelMap.get(id);
    if (existing) {
      modelMap.set(id, applyPatch(existing, patchEntry));
    }
  }
  for (const model of customModels) {
    const existing = modelMap.get(model.id);
    const patchEntry = patchData[model.id];
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

function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return Array.isArray(filePath) ? [] : {};
  }
}

function formatContextWindow(n) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return n.toString();
}

function generateReadmeTable(models) {
  const lines = [
    "| Model | Base | Context | Vision | Reasoning | Max Output |",
    "|-------|------|---------|--------|-----------|------------|",
  ];

  for (const model of models) {
    const name = model.name.replace(/^Umans\s+/, "");
    const base = model._meta?.baseModel || "—";
    const context = formatContextWindow(model.contextWindow);
    const vision = model.input.includes("image") ? "✅" : "❌";
    const reasoning = model.reasoning ? "✅" : "❌";
    const maxTokens = formatContextWindow(model.maxTokens);

    lines.push(`| ${name} | ${base} | ${context} | ${vision} | ${reasoning} | ${maxTokens} |`);
  }

  return lines.join("\n");
}

function updateReadme(models) {
  let readme = fs.readFileSync(README_PATH, "utf8");
  const newTable = generateReadmeTable(models);

  const tableRegex =
    /(## Available Models\n\n)\| Model \| Base \| Context \| Vision \| Reasoning \| Max Output \|\n\|[-| ]+\|(\n\|[^\n]+\|)*\n*/;

  if (tableRegex.test(readme)) {
    readme = readme.replace(tableRegex, (match, header) => `${header}${newTable}\n\n`);
    fs.writeFileSync(README_PATH, readme);
    console.log("✓ Updated README.md");
  } else {
    console.warn('⚠ Could not find model table in "## Available Models" section');
  }
}

function cleanModelForJson(model) {
  const { _meta, ...cleanModel } = model;
  return cleanModel;
}

async function main() {
  console.log(`Fetching models from ${MODELS_INFO_API_URL}...`);

  try {
    const response = await fetch(MODELS_INFO_API_URL);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const apiData = await response.json();

    if (!apiData || typeof apiData !== "object") {
      throw new Error("API response is not a valid object");
    }

    // Load existing models.json — source of truth for curated specs
    let existingModels = [];
    try {
      existingModels = JSON.parse(fs.readFileSync(MODELS_JSON_PATH, "utf8"));
    } catch {}
    const existingModelsMap = {};
    for (const m of existingModels) {
      existingModelsMap[m.id] = m;
    }

    // Transform models from API
    let apiTransformed = Object.entries(apiData)
      .map(([id, info]) => transformApiModel(id, info))
      .filter((m) => m !== null);

    // Enrich with base model info for README
    apiTransformed = apiTransformed.map((model) => {
      const info = apiData[model.id];
      const baseModel = info?.base_model?.oss_base || info?.base_model?.name || "—";
      return { ...model, _meta: { baseModel } };
    });

    // Sort models alphabetically by name
    apiTransformed.sort((a, b) => a.name.localeCompare(b.name));

    console.log(`✓ Fetched and transformed ${apiTransformed.length} models from API`);

    // Preserve existing curated data (compat, reasoning flags, etc.)
    apiTransformed = apiTransformed.map((model) => {
      const existing = existingModelsMap[model.id];
      if (existing) {
        return {
          ...model,
          // Preserve curated fields that the API doesn't provide
          reasoning: typeof existing.reasoning === "boolean" ? existing.reasoning : model.reasoning,
          input: existing.input || model.input,
          maxTokens: existing.maxTokens || model.maxTokens,
          _meta: model._meta, // Keep API-derived _meta for README
        };
      }
      return model;
    });

    // Update models.json — pure API data, no patches baked in
    const cleanModels = apiTransformed.map(cleanModelForJson);
    fs.writeFileSync(MODELS_JSON_PATH, JSON.stringify(cleanModels, null, 2) + "\n");
    console.log("✓ Updated models.json (pure API data)");

    // Load patch.json and apply for README generation
    let patch = {};
    try {
      patch = JSON.parse(fs.readFileSync(PATCH_JSON_PATH, "utf8"));
      console.log(`✓ Loaded ${Object.keys(patch).length} patch overrides from patch.json`);
    } catch {
      console.warn("⚠ Could not load patch.json, README may show incorrect compat flags");
    }

    // Build full model list for README: base → patch → custom
    const customModels = loadJson(CUSTOM_MODELS_JSON_PATH);
    const readmeModels = buildModels(apiTransformed, Array.isArray(customModels) ? customModels : [], patch);
    readmeModels.sort((a, b) => a.name.localeCompare(b.name));
    console.log("✓ Built model list (base → patch → custom) for README");

    // Update README.md with patched data
    updateReadme(readmeModels);

    // Summary
    console.log("\n--- Summary ---");
    console.log(`Total models: ${readmeModels.length}`);
    console.log(`Reasoning models: ${readmeModels.filter((m) => m.reasoning).length}`);
    console.log(`Vision models: ${readmeModels.filter((m) => m.input.includes("image")).length}`);
    console.log(`Subscription-based: All models $0/M (included in plan)`);

    const oldIds = new Set(existingModels.map((m) => m.id));
    const newIds = new Set(apiTransformed.map((m) => m.id));

    const added = [...newIds].filter((id) => !oldIds.has(id));
    const removed = [...oldIds].filter((id) => !newIds.has(id));

    if (added.length > 0) {
      console.log(`\nNew models: ${added.join(", ")}`);
    }
    if (removed.length > 0) {
      console.log(`\nRemoved models: ${removed.join(", ")}`);
    }
  } catch (error) {
    console.error("Error:", error.message);
    process.exit(1);
  }
}

main();
