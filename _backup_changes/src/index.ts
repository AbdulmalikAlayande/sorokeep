#!/usr/bin/env node
import { Command } from "commander";
import { initLogger } from "./logging";
import { registerWatchCommand } from "./commands/watch";
import { registerStatusCommand } from "./commands/status";
import { registerDaemonCommand } from "./commands/daemon";
import { registerAlertsCommand } from "./commands/alerts";

initLogger({ mode: "cli" });

const program = new Command();

program
    .name("sentinel")
    .description("Soroban Sentinel — The missing operations layer for deployed Soroban smart contracts")
    .version("0.1.0");

registerWatchCommand(program);
registerStatusCommand(program);
registerDaemonCommand(program);
registerAlertsCommand(program);

// Placeholder commands — future milestones
program
    .command("guard <contractId>")
    .description("Configure auto-extension policy for a contract")
    .action(() => console.log("guard command — not yet implemented"));

program
    .command("costs <contractId>")
    .description("Show rent costs and forecasts for a contract")
    .action(() => console.log("costs command — not yet implemented"));

program
    .command("restore <contractId>")
    .description("Restore archived entries for a contract")
    .action(() => console.log("restore command — not yet implemented"));

program.parse(process.argv);
