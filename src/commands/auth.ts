import { spawn } from "node:child_process";

import { confirm as clackConfirm } from "@clack/prompts";

import {
  CLAUDE_CLI_PROFILE_ID,
  loadAuthProfileStore,
  saveAuthProfileStore,
} from "../agents/auth-profiles.js";
import { CONFIG_PATH_CLAWDBOT } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { stylePromptMessage } from "../terminal/prompt-style.js";
import { updateConfig } from "./models/shared.js";
import { applyAuthProfileConfig } from "./onboard-auth.js";

const confirm = (params: Parameters<typeof clackConfirm>[0]) =>
  clackConfirm({
    ...params,
    message: stylePromptMessage(params.message),
  });

/** Parse the long-lived OAuth token from `claude setup-token` output. */
function parseOAuthToken(output: string): string | null {
  // Token format: sk-ant-oat01-...
  const match = output.match(/sk-ant-oat01-[A-Za-z0-9_-]+/);
  return match?.[0] ?? null;
}

/**
 * `clawdbot auth` - Run Anthropic OAuth via `claude setup-token`.
 *
 * Runs the Claude CLI's setup-token flow, captures the generated token,
 * and saves it directly to auth-profiles.json. The token is valid for 1 year.
 */
export async function authCommand(
  opts: { yes?: boolean },
  runtime: RuntimeEnv,
): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new Error("`clawdbot auth` requires an interactive TTY.");
  }

  if (!opts.yes) {
    const proceed = await confirm({
      message: "Run `claude setup-token` to authenticate with Anthropic?",
      initialValue: true,
    });
    if (proceed !== true) {
      runtime.log("Cancelled.");
      return;
    }
  }

  // Run claude setup-token, capturing stdout while passing through stdin/stderr
  // for the interactive browser OAuth flow.
  const token = await new Promise<string>((resolve, reject) => {
    let stdout = "";
    const proc = spawn("claude", ["setup-token"], {
      stdio: ["inherit", "pipe", "inherit"],
    });

    proc.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      // Echo to user so they see the token
      process.stdout.write(text);
    });

    proc.on("error", reject);

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`claude setup-token failed (exit ${code})`));
        return;
      }
      const parsed = parseOAuthToken(stdout);
      if (!parsed) {
        reject(
          new Error(
            "Could not parse OAuth token from claude setup-token output. " +
              "You can manually set CLAUDE_CODE_OAUTH_TOKEN env var.",
          ),
        );
        return;
      }
      resolve(parsed);
    });
  });

  // Save the token directly to auth-profiles.json as a TokenCredential.
  // The token is valid for 1 year per Claude CLI docs.
  const store = loadAuthProfileStore();
  const oneYearMs = 365 * 24 * 60 * 60 * 1000;
  store.profiles[CLAUDE_CLI_PROFILE_ID] = {
    type: "token",
    provider: "anthropic",
    token,
    expires: Date.now() + oneYearMs,
  };
  saveAuthProfileStore(store);

  await updateConfig((cfg) =>
    applyAuthProfileConfig(cfg, {
      profileId: CLAUDE_CLI_PROFILE_ID,
      provider: "anthropic",
      mode: "oauth",
    }),
  );

  runtime.log(`Updated ${CONFIG_PATH_CLAWDBOT}`);
  runtime.log(`Auth profile: ${CLAUDE_CLI_PROFILE_ID} (token, expires in 1 year)`);
}
