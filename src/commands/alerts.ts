import { Command } from "commander";

export function registerAlertsCommand(program: Command): void {
    program
        .command("alerts")
        .description("Manage alert configurations");
}
