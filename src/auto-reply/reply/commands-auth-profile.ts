import { resolveAgentDir, resolveDefaultAgentId, resolveSessionAgentId } from "../../agents/agent-scope.js";
import {
  ensureAuthProfileStore,
  listProfilesForProvider,
  resolveAuthProfileDisplayLabel,
  resolveAuthProfileOrder,
} from "../../agents/auth-profiles.js";
import { normalizeProviderId } from "../../agents/model-selection.js";
import type { ClawdbotConfig } from "../../config/config.js";
import { type SessionEntry, saveSessionStore } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import type { CommandHandler } from "./commands-types.js";
import { resolveProfileOverride } from "./directive-handling.auth.js";

type AuthProfileCommand =
  | { action: "show" }
  | { action: "set"; profileId: string }
  | { action: "clear" }
  | { action: "next" }
  | { action: "error"; message: string };

function parseAuthProfileCommand(raw: string): AuthProfileCommand | null {
  const trimmed = raw.trim();
  const lowered = trimmed.toLowerCase();
  if (!lowered.startsWith("/auth-profile") && !lowered.startsWith("/auth")) return null;
  // Parse "/auth-profile <action|profileId>" with light validation and common aliases.
  const rest = trimmed
    .replace(/^\/auth-profile\b/i, "")
    .replace(/^\/auth\b/i, "")
    .trim();
  if (!rest) return { action: "show" };
  const token = rest.split(/\s+/)[0]?.toLowerCase();
  if (token === "list" || token === "show") return { action: "show" };
  if (token === "clear" || token === "reset" || token === "unset") return { action: "clear" };
  if (token === "next" || token === "swap") return { action: "next" };
  const profileId = rest.replace(/^set\s+/i, "").trim();
  if (!profileId) {
    return { action: "error", message: "Usage: /auth-profile <profileId|list|clear|next>" };
  }
  return { action: "set", profileId };
}

function resolveStatusAgentDir(params: {
  cfg: ClawdbotConfig;
  sessionKey: string;
}): string {
  const agentId = params.sessionKey
    ? resolveSessionAgentId({ sessionKey: params.sessionKey, config: params.cfg })
    : resolveDefaultAgentId(params.cfg);
  return resolveAgentDir(params.cfg, agentId);
}

function updateAuthProfileOverride(params: {
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  profileId?: string;
}): Promise<boolean> {
  // Persist the override to the session store so the next run uses it.
  const { sessionEntry, sessionStore, sessionKey, storePath, profileId } = params;
  if (!sessionEntry || !sessionStore || !sessionKey) return Promise.resolve(false);
  if (profileId) {
    sessionEntry.authProfileOverride = profileId;
  } else {
    delete sessionEntry.authProfileOverride;
  }
  sessionEntry.updatedAt = Date.now();
  sessionStore[sessionKey] = sessionEntry;
  if (!storePath) return Promise.resolve(true);
  return saveSessionStore(storePath, sessionStore).then(() => true);
}

function formatAuthProfileList(params: {
  provider: string;
  profiles: string[];
  store: ReturnType<typeof ensureAuthProfileStore>;
  currentProfile?: string;
  cfg: ClawdbotConfig;
}): string {
  // Show current profile + available choices for the active provider.
  if (params.profiles.length === 0) {
    return `No auth profiles found for ${params.provider}.`;
  }
  const lines = [`Auth profiles for ${params.provider}:`];
  for (const profileId of params.profiles) {
    const label = resolveAuthProfileDisplayLabel({
      cfg: params.cfg,
      store: params.store,
      profileId,
    });
    const active = profileId === params.currentProfile ? " (active)" : "";
    lines.push(`- ${label}${active}`);
  }
  return lines.join("\n");
}

/**
 * Handle /auth-profile commands to list or switch auth profiles for the session.
 */
export const handleAuthProfileCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) return null;
  const authCommand = parseAuthProfileCommand(params.command.commandBodyNormalized);
  if (!authCommand) return null;
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /auth-profile from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  if (authCommand.action === "error") {
    return { shouldContinue: false, reply: { text: `⚠️ ${authCommand.message}` } };
  }

  const provider = normalizeProviderId(params.provider);
  const agentDir = resolveStatusAgentDir({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  });
  const store = ensureAuthProfileStore(agentDir, {
    allowKeychainPrompt: false,
  });
  const preferredProfile = params.sessionEntry?.authProfileOverride?.trim();
  const order = resolveAuthProfileOrder({
    cfg: params.cfg,
    store,
    provider,
    preferredProfile,
  });
  const profiles = order.length > 0 ? order : listProfilesForProvider(store, provider);

  if (authCommand.action === "show") {
    const text = formatAuthProfileList({
      provider,
      profiles,
      store,
      currentProfile: preferredProfile ?? profiles[0],
      cfg: params.cfg,
    });
    return { shouldContinue: false, reply: { text } };
  }

  if (authCommand.action === "clear") {
    const updated = await updateAuthProfileOverride({
      sessionEntry: params.sessionEntry,
      sessionStore: params.sessionStore,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    });
    const text = updated
      ? "Auth profile override cleared."
      : "⚠️ No active session to update.";
    return { shouldContinue: false, reply: { text } };
  }

  if (authCommand.action === "next") {
    if (profiles.length < 2) {
      return {
        shouldContinue: false,
        reply: { text: "No alternative auth profiles available." },
      };
    }
    const current = preferredProfile ?? profiles[0];
    const currentIndex = profiles.indexOf(current);
    const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % profiles.length : 0;
    const nextProfile = profiles[nextIndex] ?? profiles[0];
    const updated = await updateAuthProfileOverride({
      sessionEntry: params.sessionEntry,
      sessionStore: params.sessionStore,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      profileId: nextProfile,
    });
    const text = updated
      ? `Auth profile set to ${nextProfile}.`
      : "⚠️ No active session to update.";
    return { shouldContinue: false, reply: { text } };
  }

  const resolved = resolveProfileOverride({
    rawProfile: authCommand.profileId,
    provider,
    cfg: params.cfg,
    agentDir,
  });
  if (resolved.error) {
    return { shouldContinue: false, reply: { text: `⚠️ ${resolved.error}` } };
  }
  const updated = await updateAuthProfileOverride({
    sessionEntry: params.sessionEntry,
    sessionStore: params.sessionStore,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    profileId: resolved.profileId,
  });
  const text = updated
    ? `Auth profile set to ${resolved.profileId}.`
    : "⚠️ No active session to update.";
  return { shouldContinue: false, reply: { text } };
};
