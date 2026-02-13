import { homedir } from "os";
import { join } from "path";

export type LcmConfig = {
  enabled: boolean;
  databasePath: string;
  contextThreshold: number;
  freshTailCount: number;
  leafTargetTokens: number;
  condensedTargetTokens: number;
  maxExpandTokens: number;
  autocompactDisabled: boolean;
};

export function resolveLcmConfig(env: NodeJS.ProcessEnv = process.env): LcmConfig {
  return {
    enabled: env.LCM_ENABLED === "true",
    databasePath:
      env.LCM_DATABASE_PATH ?? join(homedir(), ".openclaw", "lcm.db"),
    contextThreshold: parseFloat(env.LCM_CONTEXT_THRESHOLD ?? "0.75"),
    freshTailCount: parseInt(env.LCM_FRESH_TAIL_COUNT ?? "8", 10),
    leafTargetTokens: parseInt(env.LCM_LEAF_TARGET_TOKENS ?? "600", 10),
    condensedTargetTokens: parseInt(env.LCM_CONDENSED_TARGET_TOKENS ?? "900", 10),
    maxExpandTokens: parseInt(env.LCM_MAX_EXPAND_TOKENS ?? "4000", 10),
    autocompactDisabled: env.LCM_AUTOCOMPACT_DISABLED === "true",
  };
}
