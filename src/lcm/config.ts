import type { OpenClawConfig } from "../config/config.js";
import type { OpenClawPluginConfigSchema } from "../plugins/types.js";

/**
 * Runtime LCM configuration.
 */
export type LcmConfig = {
  enabled: boolean;
  ingestTokenThreshold: number;
  compactionTokenThreshold: number;
  freshTailCount: number;
  targetTokens: number;
  retrievalK: number;
};

/**
 * Optional fields accepted from plugin config and top-level OpenClaw config.
 */
export type LcmConfigInput = Partial<LcmConfig>;

export const LCM_ENV_KEYS = {
  enabled: "LCM_ENABLED",
  ingestTokenThreshold: "LCM_INGEST_TOKEN_THRESHOLD",
  compactionTokenThreshold: "LCM_COMPACTION_TOKEN_THRESHOLD",
  freshTailCount: "LCM_FRESH_TAIL_COUNT",
  targetTokens: "LCM_TARGET_TOKENS",
  retrievalK: "LCM_RETRIEVAL_K",
} as const;

/**
 * Default values for the scaffolded LCM runtime.
 */
export const DEFAULT_LCM_CONFIG: LcmConfig = {
  enabled: true,
  ingestTokenThreshold: 14_000,
  compactionTokenThreshold: 24_000,
  freshTailCount: 8,
  targetTokens: 10_000,
  retrievalK: 20,
};

const LCM_CONFIG_FIELDS = Object.keys(DEFAULT_LCM_CONFIG) as Array<keyof LcmConfig>;

const LCM_PLUGIN_CONFIG_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },
    ingestTokenThreshold: { type: "number", minimum: 1 },
    compactionTokenThreshold: { type: "number", minimum: 1 },
    freshTailCount: { type: "number", minimum: 0 },
    targetTokens: { type: "number", minimum: 1 },
    retrievalK: { type: "number", minimum: 1 },
  },
};

/**
 * Plugin config schema used by the LCM plugin entrypoint.
 */
export const LCM_PLUGIN_CONFIG_SCHEMA: OpenClawPluginConfigSchema = {
  validate(value) {
    const result = parseLcmConfigInput(value);
    if (!result.ok) {
      return result;
    }
    return { ok: true, value: result.value };
  },
  jsonSchema: LCM_PLUGIN_CONFIG_JSON_SCHEMA,
};

/**
 * Parse untrusted input into a normalized partial config.
 */
export function parseLcmConfigInput(value: unknown):
  | { ok: true; value: LcmConfigInput }
  | {
      ok: false;
      errors: string[];
    } {
  if (value === undefined) {
    return { ok: true, value: {} };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: ["LCM config must be an object."] };
  }

  const record = value as Record<string, unknown>;
  const errors: string[] = [];
  const parsed: LcmConfigInput = {};

  if (record.enabled !== undefined) {
    if (typeof record.enabled !== "boolean") {
      errors.push("enabled must be a boolean.");
    } else {
      parsed.enabled = record.enabled;
    }
  }

  const numericFields: Array<{
    key: Exclude<keyof LcmConfig, "enabled">;
    min: number;
  }> = [
    { key: "ingestTokenThreshold", min: 1 },
    { key: "compactionTokenThreshold", min: 1 },
    { key: "freshTailCount", min: 0 },
    { key: "targetTokens", min: 1 },
    { key: "retrievalK", min: 1 },
  ];

  for (const { key, min } of numericFields) {
    const raw = record[key];
    if (raw === undefined) {
      continue;
    }
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      errors.push(`${key} must be a number.`);
      continue;
    }
    if (raw < min) {
      errors.push(`${key} must be >= ${min}.`);
      continue;
    }
    parsed[key] = Math.trunc(raw);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value: parsed };
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function parseIntEnv(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Merge LCM config with defaults.
 */
export function normalizeLcmConfig(input: LcmConfigInput = {}): LcmConfig {
  const merged = {
    ...DEFAULT_LCM_CONFIG,
    ...input,
  };

  // Ensure all numerics are sane even when values arrive from untyped sources.
  for (const key of LCM_CONFIG_FIELDS) {
    if (key === "enabled") {
      continue;
    }
    const value = merged[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      merged[key] = DEFAULT_LCM_CONFIG[key];
      continue;
    }
    if (value < 0) {
      merged[key] = DEFAULT_LCM_CONFIG[key];
    }
  }

  if (merged.freshTailCount < 0) {
    merged.freshTailCount = DEFAULT_LCM_CONFIG.freshTailCount;
  }
  if (merged.retrievalK < 1) {
    merged.retrievalK = DEFAULT_LCM_CONFIG.retrievalK;
  }
  if (merged.ingestTokenThreshold < 1) {
    merged.ingestTokenThreshold = DEFAULT_LCM_CONFIG.ingestTokenThreshold;
  }
  if (merged.compactionTokenThreshold < 1) {
    merged.compactionTokenThreshold = DEFAULT_LCM_CONFIG.compactionTokenThreshold;
  }
  if (merged.targetTokens < 1) {
    merged.targetTokens = DEFAULT_LCM_CONFIG.targetTokens;
  }

  return merged;
}

/**
 * Resolve final LCM config from OpenClaw config, plugin config, and env vars.
 */
export function resolveLcmConfig(params: {
  config?: OpenClawConfig;
  pluginConfig?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
}): LcmConfig {
  const env = params.env ?? process.env;
  const topLevelInput =
    params.config?.contextEngine && typeof params.config.contextEngine === "object"
      ? (params.config.contextEngine.lcm as LcmConfigInput | undefined)
      : undefined;
  const pluginParsed = parseLcmConfigInput(params.pluginConfig);
  const pluginInput = pluginParsed.ok ? pluginParsed.value : {};

  const envInput: LcmConfigInput = {
    enabled: parseBooleanEnv(env[LCM_ENV_KEYS.enabled]),
    ingestTokenThreshold: parseIntEnv(env[LCM_ENV_KEYS.ingestTokenThreshold]),
    compactionTokenThreshold: parseIntEnv(env[LCM_ENV_KEYS.compactionTokenThreshold]),
    freshTailCount: parseIntEnv(env[LCM_ENV_KEYS.freshTailCount]),
    targetTokens: parseIntEnv(env[LCM_ENV_KEYS.targetTokens]),
    retrievalK: parseIntEnv(env[LCM_ENV_KEYS.retrievalK]),
  };

  return normalizeLcmConfig({
    ...topLevelInput,
    ...pluginInput,
    ...envInput,
  });
}
