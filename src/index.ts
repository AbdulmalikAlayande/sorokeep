#!/usr/bin/env node
import { Command } from "commander";
import { initLogger } from "./logging";
import { registerWatchCommand } from "./commands/watch";
import { registerStatusCommand } from "./commands/status";
import { registerDaemonCommand } from "./commands/daemon";

initLogger({ mode: "cli" });

const program = new Command();

program
    .name("soroban-sentinel")
    .description("Soroban Sentinel — Operational layer for deployed Soroban smart contracts (TTL management, alerts, auto-extension)")
    .version("0.1.0");

registerWatchCommand(program);
registerStatusCommand(program);
registerDaemonCommand(program);



program
    .command("costs <contractId>")
    .description("Show rent costs and forecasts for a contract")
    .action(() => {
        console.log("costs command — not yet implemented");
    });

program
    .command("restore <contractId>")
    .description("Restore archived entries for a contract")
    .action(() => {
        console.log("restore command — not yet implemented");
    });

program.parse(process.argv);
