import type { Command } from "commander";
import { addGatewayRunCommand } from "./run.js";

/**
 * Register the legacy gateway-daemon alias for running the gateway foreground command.
 */
export function registerGatewayDaemonCli(program: Command) {
  addGatewayRunCommand(
    program.command("gateway-daemon").description("Compatibility alias for `gateway run`"),
  );
}
