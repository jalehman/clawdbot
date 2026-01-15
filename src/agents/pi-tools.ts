import fs from "node:fs/promises";
import path from "node:path";
import {
  codingTools,
  createEditTool,
  createFindTool,
  createGrepTool,
  createReadTool,
  createWriteTool,
  readTool,
} from "@mariozechner/pi-coding-agent";
import type { ClawdbotConfig } from "../config/config.js";
import { isSubagentSessionKey } from "../routing/session-key.js";
import { resolveGatewayMessageChannel } from "../utils/message-channel.js";
import { createApplyPatchTool } from "./apply-patch.js";
import {
  createExecTool,
  createProcessTool,
  type ExecToolDefaults,
  type ProcessToolDefaults,
} from "./bash-tools.js";
import { listChannelAgentTools } from "./channel-tools.js";
import { createClawdbotTools } from "./clawdbot-tools.js";
import type { ModelAuthMode } from "./model-auth.js";
import { wrapToolWithAbortSignal } from "./pi-tools.abort.js";
import {
  filterToolsByPolicy,
  isToolAllowedByPolicies,
  resolveEffectiveToolPolicy,
  resolveSubagentToolPolicy,
} from "./pi-tools.policy.js";
import {
  assertRequiredParams,
  assertSandboxPath,
  CLAUDE_PARAM_GROUPS,
  createClawdbotReadTool,
  createSandboxedEditTool,
  createSandboxedReadTool,
  createSandboxedWriteTool,
  normalizeToolParams,
  patchToolSchemaForClaudeCompatibility,
  wrapSandboxPathGuard,
  wrapToolParamNormalization,
} from "./pi-tools.read.js";
import { cleanToolSchemaForGemini, normalizeToolParameters } from "./pi-tools.schema.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
import type { SandboxContext } from "./sandbox.js";
import { resolveToolProfilePolicy } from "./tool-policy.js";

// Claude Code OAuth tool profile types and schemas
type ClaudeCodeToolProfile = "claude-code";

const CLAUDE_CODE_BASH_SCHEMA = {
  type: "object",
  properties: {
    command: { type: "string", description: "Bash command to execute" },
    description: { type: "string", description: "Reason for running the command" },
  },
  required: ["command"],
} as const;

const CLAUDE_CODE_READ_SCHEMA = {
  type: "object",
  properties: {
    file_path: { type: "string", description: "Path to the file to read" },
    offset: {
      type: "number",
      description: "Line number to start reading from (1-indexed)",
    },
    limit: { type: "number", description: "Maximum number of lines to read" },
  },
  required: ["file_path"],
} as const;

const CLAUDE_CODE_WRITE_SCHEMA = {
  type: "object",
  properties: {
    file_path: { type: "string", description: "Path to the file to write" },
    content: { type: "string", description: "Content to write" },
  },
  required: ["file_path", "content"],
} as const;

const CLAUDE_CODE_EDIT_SCHEMA = {
  type: "object",
  properties: {
    file_path: { type: "string", description: "Path to the file to edit" },
    old_string: { type: "string", description: "Text to replace" },
    new_string: { type: "string", description: "Replacement text" },
    replace_all: { type: "boolean", description: "Replace all occurrences" },
  },
  required: ["file_path", "old_string", "new_string"],
} as const;

const CLAUDE_CODE_GLOB_SCHEMA = {
  type: "object",
  properties: {
    pattern: { type: "string", description: "Glob pattern" },
    path: { type: "string", description: "Directory to search" },
    limit: { type: "number", description: "Max results" },
  },
  required: ["pattern"],
} as const;

const CLAUDE_CODE_GREP_SCHEMA = {
  type: "object",
  properties: {
    pattern: { type: "string", description: "Search pattern" },
    path: { type: "string", description: "Directory or file to search" },
    output_mode: {
      type: "string",
      description: "Output mode (content|files_with_matches)",
    },
    head_limit: { type: "number", description: "Limit number of results" },
  },
  required: ["pattern"],
} as const;

function isOpenAIProvider(provider?: string) {
  const normalized = provider?.trim().toLowerCase();
  return normalized === "openai" || normalized === "openai-codex";
}

function isApplyPatchAllowedForModel(params: {
  modelProvider?: string;
  modelId?: string;
  allowModels?: string[];
}) {
  const allowModels = Array.isArray(params.allowModels) ? params.allowModels : [];
  if (allowModels.length === 0) return true;
  const modelId = params.modelId?.trim();
  if (!modelId) return false;
  const normalizedModelId = modelId.toLowerCase();
  const provider = params.modelProvider?.trim().toLowerCase();
  const normalizedFull =
    provider && !normalizedModelId.includes("/")
      ? `${provider}/${normalizedModelId}`
      : normalizedModelId;
  return allowModels.some((entry) => {
    const normalized = entry.trim().toLowerCase();
    if (!normalized) return false;
    return normalized === normalizedModelId || normalized === normalizedFull;
  });
}

// Wraps a tool with Claude Code-compatible schema and input mapping.
function wrapClaudeCodeTool(params: {
  base: AnyAgentTool;
  name: string;
  schema: Record<string, unknown>;
  mapInput: (input: Record<string, unknown>) => Record<string, unknown>;
}): AnyAgentTool {
  return {
    ...params.base,
    name: params.name,
    label: params.name,
    parameters: params.schema,
    execute: (toolCallId, args, signal, onUpdate) => {
      const record =
        args && typeof args === "object"
          ? (args as Record<string, unknown>)
          : {};
      return params.base.execute(
        toolCallId,
        params.mapInput(record),
        signal,
        onUpdate,
      );
    },
  };
}

// Wraps edit with Claude Code schema and adds a replace_all fallback.
function wrapClaudeCodeEditTool(params: {
  base: AnyAgentTool;
  sandboxRoot?: string;
}): AnyAgentTool {
  return {
    ...params.base,
    name: "edit",
    label: "edit",
    parameters: CLAUDE_CODE_EDIT_SCHEMA,
    execute: async (toolCallId, args, signal, onUpdate) => {
      const record =
        args && typeof args === "object"
          ? (args as Record<string, unknown>)
          : {};
      const filePath =
        typeof record.file_path === "string" ? record.file_path : "";
      const oldString =
        typeof record.old_string === "string" ? record.old_string : "";
      const newString =
        typeof record.new_string === "string" ? record.new_string : "";
      const replaceAll = record.replace_all === true;

      // Default to the base edit tool unless replace_all is requested.
      if (!replaceAll) {
        return params.base.execute(
          toolCallId,
          { path: filePath, oldText: oldString, newText: newString },
          signal,
          onUpdate,
        );
      }

      // Simple replace-all fallback for Claude Code compatibility.
      if (!filePath.trim()) {
        throw new Error("Edit requires file_path.");
      }
      if (!oldString) {
        throw new Error("Edit requires old_string.");
      }
      if (typeof record.new_string !== "string") {
        throw new Error("Edit requires new_string.");
      }
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }
      if (params.sandboxRoot) {
        await assertSandboxPath({
          filePath,
          cwd: params.sandboxRoot,
          root: params.sandboxRoot,
        });
      }

      const absolutePath = path.resolve(process.cwd(), filePath);
      const rawContent = await fs.readFile(absolutePath, "utf8");
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }
      const bom = rawContent.startsWith("\uFEFF") ? "\uFEFF" : "";
      const content = bom ? rawContent.slice(1) : rawContent;
      if (!content.includes(oldString)) {
        throw new Error(
          `Could not find the exact text in ${filePath}. The old text must match exactly including all whitespace and newlines.`,
        );
      }
      const replaced = content.split(oldString).join(newString);
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }
      await fs.writeFile(absolutePath, `${bom}${replaced}`, "utf8");
      return {
        content: [
          {
            type: "text",
            text: `Successfully replaced text in ${filePath}.`,
          },
        ],
        details: undefined,
      };
    },
  };
}

// Builds the restricted Claude Code tool set with CC-compatible names/schemas.
function createClaudeCodeCompatibilityTools(
  options?: {
    exec?: ExecToolDefaults & ProcessToolDefaults;
    sandbox?: SandboxContext | null;
  },
): AnyAgentTool[] {
  const sandbox = options?.sandbox?.enabled ? options.sandbox : undefined;
  const sandboxRoot = sandbox?.workspaceDir;
  const allowWorkspaceWrites = sandbox?.workspaceAccess !== "ro";

  // Build base tools with the same sandbox rules as the default tool set.
  const readBase = sandboxRoot
    ? createSandboxedReadTool(sandboxRoot)
    : createClawdbotReadTool(createReadTool(process.cwd()) as unknown as AnyAgentTool);
  const editBase = allowWorkspaceWrites
    ? sandboxRoot
      ? createSandboxedEditTool(sandboxRoot)
      : (createEditTool(process.cwd()) as unknown as AnyAgentTool)
    : null;
  const writeBase = allowWorkspaceWrites
    ? sandboxRoot
      ? createSandboxedWriteTool(sandboxRoot)
      : (createWriteTool(process.cwd()) as unknown as AnyAgentTool)
    : null;
  const globBase = sandboxRoot
    ? wrapSandboxPathGuard(
        createFindTool(sandboxRoot) as unknown as AnyAgentTool,
        sandboxRoot,
      )
    : (createFindTool(process.cwd()) as unknown as AnyAgentTool);
  const grepBase = sandboxRoot
    ? wrapSandboxPathGuard(
        createGrepTool(sandboxRoot) as unknown as AnyAgentTool,
        sandboxRoot,
      )
    : (createGrepTool(process.cwd()) as unknown as AnyAgentTool);
  const bashBase = createExecTool({
    ...options?.exec,
    sandbox: sandbox
      ? {
          containerName: sandbox.containerName,
          workspaceDir: sandbox.workspaceDir,
          containerWorkdir: sandbox.containerWorkdir,
          env: sandbox.docker.env,
        }
      : undefined,
  });

  // Expose only the Claude Code tool names and schemas.
  const tools: AnyAgentTool[] = [
    wrapClaudeCodeTool({
      base: bashBase as unknown as AnyAgentTool,
      name: "bash",
      schema: CLAUDE_CODE_BASH_SCHEMA,
      mapInput: (record) => ({
        command: typeof record.command === "string" ? record.command : "",
      }),
    }),
    wrapClaudeCodeTool({
      base: readBase,
      name: "read",
      schema: CLAUDE_CODE_READ_SCHEMA,
      mapInput: (record) => ({
        path: typeof record.file_path === "string" ? record.file_path : "",
        offset: typeof record.offset === "number" ? record.offset : undefined,
        limit: typeof record.limit === "number" ? record.limit : undefined,
      }),
    }),
    ...(editBase
      ? [wrapClaudeCodeEditTool({ base: editBase, sandboxRoot })]
      : []),
    ...(writeBase
      ? [
          wrapClaudeCodeTool({
            base: writeBase,
            name: "write",
            schema: CLAUDE_CODE_WRITE_SCHEMA,
            mapInput: (record) => ({
              path:
                typeof record.file_path === "string" ? record.file_path : "",
              content: typeof record.content === "string" ? record.content : "",
            }),
          }),
        ]
      : []),
    wrapClaudeCodeTool({
      base: globBase,
      name: "find",
      schema: CLAUDE_CODE_GLOB_SCHEMA,
      mapInput: (record) => ({
        pattern: typeof record.pattern === "string" ? record.pattern : "",
        path: typeof record.path === "string" ? record.path : undefined,
        limit: typeof record.limit === "number" ? record.limit : undefined,
      }),
    }),
    wrapClaudeCodeTool({
      base: grepBase,
      name: "grep",
      schema: CLAUDE_CODE_GREP_SCHEMA,
      mapInput: (record) => ({
        pattern: typeof record.pattern === "string" ? record.pattern : "",
        path: typeof record.path === "string" ? record.path : undefined,
        limit:
          typeof record.head_limit === "number" ? record.head_limit : undefined,
      }),
    }),
  ];

  return tools;
}

export const __testing = {
  cleanToolSchemaForGemini,
  normalizeToolParams,
  patchToolSchemaForClaudeCompatibility,
  wrapToolParamNormalization,
  assertRequiredParams,
} as const;

export function createClawdbotCodingTools(options?: {
  exec?: ExecToolDefaults & ProcessToolDefaults;
  messageProvider?: string;
  agentAccountId?: string;
  sandbox?: SandboxContext | null;
  sessionKey?: string;
  agentDir?: string;
  workspaceDir?: string;
  config?: ClawdbotConfig;
  abortSignal?: AbortSignal;
  /**
   * Provider of the currently selected model (used for provider-specific tool quirks).
   * Example: "anthropic", "openai", "google", "openai-codex".
   */
  modelProvider?: string;
  /** Model id for the current provider (used for model-specific tool gating). */
  modelId?: string;
  /**
   * Auth mode for the current provider. We only need this for Anthropic OAuth
   * tool-name blocking quirks.
   */
  modelAuthMode?: ModelAuthMode;
  /** Tool profile for Claude Code OAuth compatibility. */
  toolProfile?: ClaudeCodeToolProfile;
  /** Current channel ID for auto-threading (Slack). */
  currentChannelId?: string;
  /** Current thread timestamp for auto-threading (Slack). */
  currentThreadTs?: string;
  /** Reply-to mode for Slack auto-threading. */
  replyToMode?: "off" | "first" | "all";
  /** Mutable ref to track if a reply was sent (for "first" mode). */
  hasRepliedRef?: { value: boolean };
}): AnyAgentTool[] {
  const execToolName = "exec";
  const sandbox = options?.sandbox?.enabled ? options.sandbox : undefined;

  // Claude Code OAuth tool profile: restricted tool set with CC-compatible names/schemas.
  if (options?.toolProfile === "claude-code") {
    const tools = createClaudeCodeCompatibilityTools({
      exec: options?.exec,
      sandbox,
    });
    // Use the same policy resolution as the main tool profile path.
    const { globalPolicy, agentPolicy } = resolveEffectiveToolPolicy({
      config: options?.config,
      sessionKey: options?.sessionKey,
      modelProvider: options?.modelProvider,
    });
    let filtered = tools;
    if (globalPolicy) filtered = filterToolsByPolicy(filtered, globalPolicy);
    if (agentPolicy) filtered = filterToolsByPolicy(filtered, agentPolicy);
    if (sandbox) filtered = filterToolsByPolicy(filtered, sandbox.tools);
    if (isSubagentSessionKey(options?.sessionKey) && options?.sessionKey) {
      filtered = filterToolsByPolicy(filtered, resolveSubagentToolPolicy(options.config));
    }
    return filtered.map(normalizeToolParameters);
  }

  const {
    agentId,
    globalPolicy,
    globalProviderPolicy,
    agentPolicy,
    agentProviderPolicy,
    profile,
    providerProfile,
  } = resolveEffectiveToolPolicy({
    config: options?.config,
    sessionKey: options?.sessionKey,
    modelProvider: options?.modelProvider,
    modelId: options?.modelId,
  });
  const profilePolicy = resolveToolProfilePolicy(profile);
  const providerProfilePolicy = resolveToolProfilePolicy(providerProfile);
  const scopeKey = options?.exec?.scopeKey ?? (agentId ? `agent:${agentId}` : undefined);
  const subagentPolicy =
    isSubagentSessionKey(options?.sessionKey) && options?.sessionKey
      ? resolveSubagentToolPolicy(options.config)
      : undefined;
  const allowBackground = isToolAllowedByPolicies("process", [
    profilePolicy,
    providerProfilePolicy,
    globalPolicy,
    globalProviderPolicy,
    agentPolicy,
    agentProviderPolicy,
    sandbox?.tools,
    subagentPolicy,
  ]);
  const sandboxRoot = sandbox?.workspaceDir;
  const allowWorkspaceWrites = sandbox?.workspaceAccess !== "ro";
  const workspaceRoot = options?.workspaceDir ?? process.cwd();
  const applyPatchConfig = options?.config?.tools?.exec?.applyPatch;
  const applyPatchEnabled =
    !!applyPatchConfig?.enabled &&
    isOpenAIProvider(options?.modelProvider) &&
    isApplyPatchAllowedForModel({
      modelProvider: options?.modelProvider,
      modelId: options?.modelId,
      allowModels: applyPatchConfig?.allowModels,
    });

  const base = (codingTools as unknown as AnyAgentTool[]).flatMap((tool) => {
    if (tool.name === readTool.name) {
      if (sandboxRoot) {
        return [createSandboxedReadTool(sandboxRoot)];
      }
      const freshReadTool = createReadTool(workspaceRoot);
      return [createClawdbotReadTool(freshReadTool as unknown as AnyAgentTool)];
    }
    if (tool.name === "bash" || tool.name === execToolName) return [];
    if (tool.name === "write") {
      if (sandboxRoot) return [];
      // Wrap with param normalization for Claude Code compatibility
      return [
        wrapToolParamNormalization(createWriteTool(workspaceRoot) as unknown as AnyAgentTool, CLAUDE_PARAM_GROUPS.write),
      ];
    }
    if (tool.name === "edit") {
      if (sandboxRoot) return [];
      // Wrap with param normalization for Claude Code compatibility
      return [wrapToolParamNormalization(createEditTool(workspaceRoot) as unknown as AnyAgentTool, CLAUDE_PARAM_GROUPS.edit)];
    }
    return [tool as AnyAgentTool];
  });
  const execTool = createExecTool({
    ...options?.exec,
    cwd: options?.workspaceDir,
    allowBackground,
    scopeKey,
    sandbox: sandbox
      ? {
          containerName: sandbox.containerName,
          workspaceDir: sandbox.workspaceDir,
          containerWorkdir: sandbox.containerWorkdir,
          env: sandbox.docker.env,
        }
      : undefined,
  });
  const bashTool = {
    ...(execTool as unknown as AnyAgentTool),
    name: "bash",
    label: "bash",
  } satisfies AnyAgentTool;
  const processTool = createProcessTool({
    cleanupMs: options?.exec?.cleanupMs,
    scopeKey,
  });
  const applyPatchTool =
    !applyPatchEnabled || (sandboxRoot && !allowWorkspaceWrites)
      ? null
      : createApplyPatchTool({
          cwd: sandboxRoot ?? workspaceRoot,
          sandboxRoot: sandboxRoot && allowWorkspaceWrites ? sandboxRoot : undefined,
        });
  const tools: AnyAgentTool[] = [
    ...base,
    ...(sandboxRoot
      ? allowWorkspaceWrites
        ? [createSandboxedEditTool(sandboxRoot), createSandboxedWriteTool(sandboxRoot)]
        : []
      : []),
    ...(applyPatchTool ? [applyPatchTool as unknown as AnyAgentTool] : []),
    execTool as unknown as AnyAgentTool,
    bashTool,
    processTool as unknown as AnyAgentTool,
    // Channel docking: include channel-defined agent tools (login, etc.).
    ...listChannelAgentTools({ cfg: options?.config }),
    ...createClawdbotTools({
      browserControlUrl: sandbox?.browser?.controlUrl,
      allowHostBrowserControl: sandbox ? sandbox.browserAllowHostControl : true,
      allowedControlUrls: sandbox?.browserAllowedControlUrls,
      allowedControlHosts: sandbox?.browserAllowedControlHosts,
      allowedControlPorts: sandbox?.browserAllowedControlPorts,
      agentSessionKey: options?.sessionKey,
      agentChannel: resolveGatewayMessageChannel(options?.messageProvider),
      agentAccountId: options?.agentAccountId,
      agentDir: options?.agentDir,
      sandboxRoot,
      workspaceDir: options?.workspaceDir,
      sandboxed: !!sandbox,
      config: options?.config,
      currentChannelId: options?.currentChannelId,
      currentThreadTs: options?.currentThreadTs,
      replyToMode: options?.replyToMode,
      hasRepliedRef: options?.hasRepliedRef,
    }),
  ];
  const toolsFiltered = profilePolicy ? filterToolsByPolicy(tools, profilePolicy) : tools;
  const providerProfileFiltered = providerProfilePolicy
    ? filterToolsByPolicy(toolsFiltered, providerProfilePolicy)
    : toolsFiltered;
  const globalFiltered = globalPolicy
    ? filterToolsByPolicy(providerProfileFiltered, globalPolicy)
    : providerProfileFiltered;
  const globalProviderFiltered = globalProviderPolicy
    ? filterToolsByPolicy(globalFiltered, globalProviderPolicy)
    : globalFiltered;
  const agentFiltered = agentPolicy
    ? filterToolsByPolicy(globalProviderFiltered, agentPolicy)
    : globalProviderFiltered;
  const agentProviderFiltered = agentProviderPolicy
    ? filterToolsByPolicy(agentFiltered, agentProviderPolicy)
    : agentFiltered;
  const sandboxed = sandbox
    ? filterToolsByPolicy(agentProviderFiltered, sandbox.tools)
    : agentProviderFiltered;
  const subagentFiltered = subagentPolicy
    ? filterToolsByPolicy(sandboxed, subagentPolicy)
    : sandboxed;
  // Always normalize tool JSON Schemas before handing them to pi-agent/pi-ai.
  // Without this, some providers (notably OpenAI) will reject root-level union schemas.
  const normalized = subagentFiltered.map(normalizeToolParameters);
  const withAbort = options?.abortSignal
    ? normalized.map((tool) => wrapToolWithAbortSignal(tool, options.abortSignal))
    : normalized;

  // NOTE: Keep canonical (lowercase) tool names here.
  // pi-ai's Anthropic OAuth transport remaps tool names to Claude Code-style names
  // on the wire and maps them back for tool dispatch.
  return withAbort;
}
