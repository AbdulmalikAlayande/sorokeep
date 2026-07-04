#!/usr/bin/env node
import { Command } from "commander";
import { initLogger } from "./logging/index.js";
import { registerWatchCommand } from "./commands/watch.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerCheckCommand } from "./commands/check.js";
import { registerDaemonCommand } from "./commands/daemon.js";
import { registerAlertsCommand } from "./commands/alerts.js";
import { registerGuardCommand } from "./commands/guard.js";
import { registerCostsCommand } from "./commands/costs.js";
import { registerResourcesCommand } from "./commands/resources.js";
import { registerRestoreCommand } from "./commands/restore.js";
import { registerChannelsCommand } from "./commands/channels.js";
import { registerCompletionCommand } from "./commands/completion.js";
import { registerInspectCommand } from "./commands/inspect.js";
import { registerBudgetCommand } from "./commands/budget.js";
import { registerDbCommand } from "./commands/db.js";

initLogger({ mode: "cli" });

const program = new Command();

program
  .name("sorokeep")
  .description(
    "Sorokeep — The missing operations layer for deployed Soroban smart contracts",
  )
  .version("0.1.2");

registerWatchCommand(program);
registerStatusCommand(program);
registerCheckCommand(program);
registerDaemonCommand(program);
registerAlertsCommand(program);
registerGuardCommand(program);
registerCostsCommand(program);
registerResourcesCommand(program);
registerRestoreCommand(program);
registerChannelsCommand(program);
registerCompletionCommand(program);
registerInspectCommand(program);
registerBudgetCommand(program);
registerDbCommand(program);

program.parse(process.argv);
