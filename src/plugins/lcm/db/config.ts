import { homedir } from "os";
import { join } from "path";

export type LcmConfig = {
  enabled: boolean;
  databasePath: string;
  contextThreshold: number;
  freshTailCount: number;
  leafChunkTokens: number;
  leafTargetTokens: number;
  condensedTargetTokens: number;
  maxExpandTokens: number;
  largeFileTokenThreshold: number;
  autocompactDisabled: boolean;
};

export function resolveLcmConfig(env: NodeJS.ProcessEnv = process.env): LcmConfig {
  return {
    enabled: env.LCM_ENABLED === "true",
    databasePath: env.LCM_DATABASE_PATH ?? join(homedir(), ".openclaw", "lcm.db"),
    contextThreshold: parseFloat(env.LCM_CONTEXT_THRESHOLD ?? "0.75"),
    freshTailCount: parseInt(env.LCM_FRESH_TAIL_COUNT ?? "32", 10),
    leafChunkTokens: parseInt(env.LCM_LEAF_CHUNK_TOKENS ?? "20000", 10),
    leafTargetTokens: parseInt(env.LCM_LEAF_TARGET_TOKENS ?? "1200", 10),
    condensedTargetTokens: parseInt(env.LCM_CONDENSED_TARGET_TOKENS ?? "2000", 10),
    maxExpandTokens: parseInt(env.LCM_MAX_EXPAND_TOKENS ?? "4000", 10),
    largeFileTokenThreshold: parseInt(env.LCM_LARGE_FILE_TOKEN_THRESHOLD ?? "25000", 10),
    autocompactDisabled: env.LCM_AUTOCOMPACT_DISABLED === "true",
  };
}
