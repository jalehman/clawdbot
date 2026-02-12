/**
 * Configuration for the pluggable context engine.
 */
export type ContextEngineConfig = {
  /** ID of the active context engine (e.g. "legacy", "lcm"). Defaults to "legacy". */
  engine?: string;
};
