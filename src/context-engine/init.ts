import { registerLegacyContextEngine } from "./legacy.js";
import { registerLcmPlugin } from "../plugins/lcm/register.js";

/**
 * Ensures all built-in context engines are registered exactly once.
 *
 * The legacy engine is always registered as a safe fallback so that
 * `resolveContextEngine()` can resolve the default "legacy" slot without
 * callers needing to remember manual registration.
 *
 * The LCM engine is registered alongside it — instantiation only happens
 * when the "lcm" slot is actually selected via config.
 */
let initialized = false;

export function ensureContextEnginesInitialized(): void {
  if (initialized) return;
  initialized = true;

  // Always available – safe fallback for the "legacy" slot default.
  registerLegacyContextEngine();

  // LCM engine – instantiated lazily only when selected via config.
  registerLcmPlugin();
}
