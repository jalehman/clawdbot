import {
  resolveAgentDir,
  resolveDefaultAgentId,
  resolveSessionAgentId,
} from "../../agents/agent-scope.js";
import { listSubagentRunsForRequester } from "../../agents/subagent-registry.js";
import {
  ensureAuthProfileStore,
  resolveApiKeyForProfile,
  resolveAuthProfileDisplayLabel,
  resolveAuthProfileOrder,
} from "../../agents/auth-profiles.js";
import { getCustomProviderApiKey, resolveEnvApiKey } from "../../agents/model-auth.js";
import {
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "../../agents/tools/sessions-helpers.js";
import { normalizeProviderId } from "../../agents/model-selection.js";
import type { ClawdbotConfig } from "../../config/config.js";
import type { SessionEntry, SessionScope } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import {
  formatUsageReportLines,
  formatUsageSummaryLine,
  loadProviderUsageSummary,
  resolveUsageProviderId,
} from "../../infra/provider-usage.js";
import { clampPercent } from "../../infra/provider-usage.shared.js";
import { normalizeGroupActivation } from "../group-activation.js";
import { buildStatusMessage } from "../status.js";
import type { ElevatedLevel, ReasoningLevel, ThinkLevel, VerboseLevel } from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import type { CommandContext } from "./commands-types.js";
import { getFollowupQueueDepth, resolveQueueSettings } from "./queue.js";
import type { MediaUnderstandingDecision } from "../../media-understanding/types.js";
import { resolveSubagentLabel } from "./subagents-utils.js";

const USAGE_ALERT_THRESHOLD_PERCENT = 5;

function formatApiKeySnippet(apiKey: string): string {
  const compact = apiKey.replace(/\s+/g, "");
  if (!compact) return "unknown";
  const edge = compact.length >= 12 ? 6 : 4;
  const head = compact.slice(0, edge);
  const tail = compact.slice(-edge);
  return `${head}…${tail}`;
}

type StatusUsageSummary = {
  summary: Awaited<ReturnType<typeof loadProviderUsageSummary>> | null;
  profileId?: string;
};

async function resolveUsageSummaryForStatus(params: {
  cfg: ClawdbotConfig;
  provider: string;
  sessionEntry?: SessionEntry;
  agentDir: string;
}): Promise<StatusUsageSummary> {
  const usageProvider = resolveUsageProviderId(params.provider);
  if (!usageProvider) return { summary: null };
  const store = ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false });
  const preferredProfile = params.sessionEntry?.authProfileOverride?.trim();
  const order = resolveAuthProfileOrder({
    cfg: params.cfg,
    store,
    provider: usageProvider,
    preferredProfile,
  });
  const candidates = [preferredProfile, ...order].filter(Boolean) as string[];
  // Prefer the currently selected profile so usage reflects the active credentials.
  for (const profileId of candidates) {
    const profile = store.profiles[profileId];
    if (!profile || normalizeProviderId(profile.provider) !== usageProvider) continue;
    let resolved: Awaited<ReturnType<typeof resolveApiKeyForProfile>>;
    try {
      resolved = await resolveApiKeyForProfile({
        cfg: params.cfg,
        store,
        profileId,
        agentDir: params.agentDir,
      });
    } catch {
      continue;
    }
    if (!resolved?.apiKey) continue;
    const accountId =
      profile.type === "oauth" && "accountId" in profile
        ? (profile as { accountId?: string }).accountId
        : undefined;
    const summary = await loadProviderUsageSummary({
      timeoutMs: 3500,
      providers: [usageProvider],
      auth: [{ provider: usageProvider, token: resolved.apiKey, accountId }],
      agentDir: params.agentDir,
    });
    return { summary, profileId };
  }
  const summary = await loadProviderUsageSummary({
    timeoutMs: 3500,
    providers: [usageProvider],
    agentDir: params.agentDir,
  });
  return { summary };
}

function formatUsageAlerts(summary: StatusUsageSummary["summary"]): string | null {
  if (!summary) return null;
  // Collect per-window alerts when remaining percentage is below threshold.
  const alerts: string[] = [];
  for (const entry of summary.providers) {
    if (entry.error || entry.windows.length === 0) continue;
    const windows = entry.windows
      .map((window) => ({
        label: window.label,
        remaining: clampPercent(100 - window.usedPercent),
      }))
      .filter((window) => window.remaining <= USAGE_ALERT_THRESHOLD_PERCENT);
    if (windows.length === 0) continue;
    const parts = windows.map((window) => `${window.label} ${window.remaining.toFixed(0)}% left`);
    alerts.push(`${entry.displayName} ${parts.join(", ")}`);
  }
  return alerts.length > 0 ? `⚠️ Usage alert: ${alerts.join(" · ")}` : null;
}

function resolveModelAuthLabel(
  provider?: string,
  cfg?: ClawdbotConfig,
  sessionEntry?: SessionEntry,
  agentDir?: string,
): string | undefined {
  const resolved = provider?.trim();
  if (!resolved) return undefined;

  const providerKey = normalizeProviderId(resolved);
  const store = ensureAuthProfileStore(agentDir, {
    allowKeychainPrompt: false,
  });
  const profileOverride = sessionEntry?.authProfileOverride?.trim();
  const order = resolveAuthProfileOrder({
    cfg,
    store,
    provider: providerKey,
    preferredProfile: profileOverride,
  });
  const candidates = [profileOverride, ...order].filter(Boolean) as string[];

  for (const profileId of candidates) {
    const profile = store.profiles[profileId];
    if (!profile || normalizeProviderId(profile.provider) !== providerKey) {
      continue;
    }
    const label = resolveAuthProfileDisplayLabel({ cfg, store, profileId });
    if (profile.type === "oauth") {
      return `oauth${label ? ` (${label})` : ""}`;
    }
    if (profile.type === "token") {
      const snippet = formatApiKeySnippet(profile.token);
      return `token ${snippet}${label ? ` (${label})` : ""}`;
    }
    const snippet = formatApiKeySnippet(profile.key);
    return `api-key ${snippet}${label ? ` (${label})` : ""}`;
  }

  const envKey = resolveEnvApiKey(providerKey);
  if (envKey?.apiKey) {
    if (envKey.source.includes("OAUTH_TOKEN")) {
      return `oauth (${envKey.source})`;
    }
    return `api-key ${formatApiKeySnippet(envKey.apiKey)} (${envKey.source})`;
  }

  const customKey = getCustomProviderApiKey(cfg, providerKey);
  if (customKey) {
    return `api-key ${formatApiKeySnippet(customKey)} (models.json)`;
  }

  return "unknown";
}

export async function buildStatusReply(params: {
  cfg: ClawdbotConfig;
  command: CommandContext;
  sessionEntry?: SessionEntry;
  sessionKey: string;
  sessionScope?: SessionScope;
  provider: string;
  model: string;
  contextTokens: number;
  resolvedThinkLevel?: ThinkLevel;
  resolvedVerboseLevel: VerboseLevel;
  resolvedReasoningLevel: ReasoningLevel;
  resolvedElevatedLevel?: ElevatedLevel;
  resolveDefaultThinkingLevel: () => Promise<ThinkLevel | undefined>;
  isGroup: boolean;
  defaultGroupActivation: () => "always" | "mention";
  mediaDecisions?: MediaUnderstandingDecision[];
}): Promise<ReplyPayload | undefined> {
  const {
    cfg,
    command,
    sessionEntry,
    sessionKey,
    sessionScope,
    provider,
    model,
    contextTokens,
    resolvedThinkLevel,
    resolvedVerboseLevel,
    resolvedReasoningLevel,
    resolvedElevatedLevel,
    resolveDefaultThinkingLevel,
    isGroup,
    defaultGroupActivation,
  } = params;
  if (!command.isAuthorizedSender) {
    logVerbose(`Ignoring /status from unauthorized sender: ${command.senderId || "<unknown>"}`);
    return undefined;
  }
  const statusAgentId = sessionKey
    ? resolveSessionAgentId({ sessionKey, config: cfg })
    : resolveDefaultAgentId(cfg);
  const statusAgentDir = resolveAgentDir(cfg, statusAgentId);
  let usageLine: string | null = null;
  let usageWarning: string | null = null;
  try {
    const usageSummary = await resolveUsageSummaryForStatus({
      cfg,
      provider,
      sessionEntry,
      agentDir: statusAgentDir,
    });
    const summary = usageSummary.summary;
    if (summary) {
      usageLine = formatUsageSummaryLine(summary, { now: Date.now() });
      usageWarning = formatUsageAlerts(summary);
      if (!usageLine && (resolvedVerboseLevel === "on" || resolvedElevatedLevel === "on")) {
        const entry = summary.providers[0];
        if (entry?.error) {
          usageLine = `📊 Usage: ${entry.displayName} (${entry.error})`;
        }
      }
    }
  } catch {
    usageLine = null;
    usageWarning = null;
  }
  const queueSettings = resolveQueueSettings({
    cfg,
    channel: command.channel,
    sessionEntry,
  });
  const queueKey = sessionKey ?? sessionEntry?.sessionId;
  const queueDepth = queueKey ? getFollowupQueueDepth(queueKey) : 0;
  const queueOverrides = Boolean(
    sessionEntry?.queueDebounceMs ?? sessionEntry?.queueCap ?? sessionEntry?.queueDrop,
  );

  let subagentsLine: string | undefined;
  if (sessionKey) {
    const { mainKey, alias } = resolveMainSessionAlias(cfg);
    const requesterKey = resolveInternalSessionKey({ key: sessionKey, alias, mainKey });
    const runs = listSubagentRunsForRequester(requesterKey);
    const verboseEnabled = resolvedVerboseLevel && resolvedVerboseLevel !== "off";
    if (runs.length > 0) {
      const active = runs.filter((entry) => !entry.endedAt);
      const done = runs.length - active.length;
      if (verboseEnabled) {
        const labels = active
          .map((entry) => resolveSubagentLabel(entry, ""))
          .filter(Boolean)
          .slice(0, 3);
        const labelText = labels.length ? ` (${labels.join(", ")})` : "";
        subagentsLine = `🤖 Subagents: ${active.length} active${labelText} · ${done} done`;
      } else if (active.length > 0) {
        subagentsLine = `🤖 Subagents: ${active.length} active`;
      }
    }
  }
  const groupActivation = isGroup
    ? (normalizeGroupActivation(sessionEntry?.groupActivation) ?? defaultGroupActivation())
    : undefined;
  const agentDefaults = cfg.agents?.defaults ?? {};
  const statusText = buildStatusMessage({
    config: cfg,
    agent: {
      ...agentDefaults,
      model: {
        ...agentDefaults.model,
        primary: `${provider}/${model}`,
      },
      contextTokens,
      thinkingDefault: agentDefaults.thinkingDefault,
      verboseDefault: agentDefaults.verboseDefault,
      elevatedDefault: agentDefaults.elevatedDefault,
    },
    sessionEntry,
    sessionKey,
    sessionScope,
    groupActivation,
    resolvedThink: resolvedThinkLevel ?? (await resolveDefaultThinkingLevel()),
    resolvedVerbose: resolvedVerboseLevel,
    resolvedReasoning: resolvedReasoningLevel,
    resolvedElevated: resolvedElevatedLevel,
    modelAuth: resolveModelAuthLabel(provider, cfg, sessionEntry, statusAgentDir),
    usageLine: usageLine ?? undefined,
    queue: {
      mode: queueSettings.mode,
      depth: queueDepth,
      debounceMs: queueSettings.debounceMs,
      cap: queueSettings.cap,
      dropPolicy: queueSettings.dropPolicy,
      showDetails: queueOverrides,
    },
    subagentsLine,
    mediaDecisions: params.mediaDecisions,
    includeTranscriptUsage: false,
  });
  const tail = usageWarning ? `${statusText}\n${usageWarning}` : statusText;
  return { text: tail };
}

/**
 * Build a detailed usage report reply for the active provider and session profile.
 */
export async function buildUsageReply(params: {
  cfg: ClawdbotConfig;
  command: CommandContext;
  sessionEntry?: SessionEntry;
  sessionKey: string;
  provider: string;
}): Promise<ReplyPayload | undefined> {
  if (!params.command.isAuthorizedSender) return undefined;
  // Use the session's active auth profile (if set) for provider usage checks.
  const statusAgentId = params.sessionKey
    ? resolveSessionAgentId({ sessionKey: params.sessionKey, config: params.cfg })
    : resolveDefaultAgentId(params.cfg);
  const statusAgentDir = resolveAgentDir(params.cfg, statusAgentId);
  let usageSummary: StatusUsageSummary;
  try {
    usageSummary = await resolveUsageSummaryForStatus({
      cfg: params.cfg,
      provider: params.provider,
      sessionEntry: params.sessionEntry,
      agentDir: statusAgentDir,
    });
  } catch (err) {
    return { text: `Usage: error (${String(err)})` };
  }
  const summary = usageSummary.summary;
  if (!summary || summary.providers.length === 0) {
    return { text: "Usage: no provider usage available." };
  }
  const lines = formatUsageReportLines(summary, { now: Date.now() });
  if (usageSummary.profileId) {
    lines.splice(1, 0, `  Profile: ${usageSummary.profileId}`);
  }
  const alert = formatUsageAlerts(summary);
  if (alert) lines.push(alert);
  return { text: lines.join("\n") };
}
