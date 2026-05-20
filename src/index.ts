#!/usr/bin/env node
import { Command } from "commander";
import { registerWatchCommand } from "./commands/watch";
import { initLogger } from "./logging";

initLogger({ mode: "cli" });

const program = new Command();

program
    .name("soroban-sentinel")
    .description("Soroban Sentinel — Operational layer for deployed Soroban smart contracts (TTL management, alerts, auto-extension)")
    .version("0.1.0");
registerWatchCommand(program);

program
    .command("status <contractId>")
    .description("Show TTL and storage health for a contract")
    .action(() => {
        console.log("status command — not yet implemented");
    });

program
    .command("guard <contractId>")
    .description("Configure auto-extension policy for a contract")
    .action(() => {
        console.log("guard command — not yet implemented");
    });

program
    .command("alerts")
    .description("Manage alert configurations")
    .action(() => {
        console.log("alerts command — not yet implemented");
    });

program
    .command("daemon")
    .description("Start the monitoring daemon")
    .action(() => {
        console.log("daemon command — not yet implemented");
    });

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

program.parse();



program.parse(process.argv);
