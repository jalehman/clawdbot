import type { Command } from "commander";
import { authCommand } from "../../commands/auth.js";
import { defaultRuntime } from "../../runtime.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";

export function registerAuthCommand(program: Command) {
  program
    .command("auth")
    .description("Authenticate with Anthropic via OAuth (runs `claude setup-token`)")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/configuration#auth-profiles", "docs.clawd.bot/configuration#auth-profiles")}\n`,
    )
    .option("--yes", "Skip confirmation prompt", false)
    .action(async (opts) => {
      try {
        await authCommand({ yes: Boolean(opts.yes) }, defaultRuntime);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });
}
