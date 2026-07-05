import { Command } from "commander";
import chalk from "chalk";
import { getDatabase } from "../db/database.js";
import { getContract, setContractActiveStatus } from "../db/repositories.js";
import { formatContractID } from "../utils/formatting.js";
import { getLogger } from "../logging/index.js";

const logger = getLogger().child({ component: "PauseCommand" });

export const registerPauseCommand = (program: Command): void => {
    program
        .command("pause <contract-id>")
        .description("Temporarily pause daemon polling and alerting for a contract")
        .action(async (contractId: string) => {
            try {
                const db = getDatabase();
                const contract = getContract(db, contractId);

                if (!contract) {
                    console.log(chalk.red(`Contract ${formatContractID(contractId)} is not being watched.`));
                    process.exit(1);
                }

                setContractActiveStatus(db, contractId, false);
                console.log(chalk.green(`Successfully paused monitoring for ${formatContractID(contractId)}.`));
                console.log(chalk.dim(`Run 'sorokeep resume ${formatContractID(contractId)}' to re-enable.`));
            } catch (error: any) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                logger.error("Pause command failed", { error: errorMessage });
                console.log(chalk.red(`Failed to pause contract: ${errorMessage}`));
                process.exit(1);
            }
        });
};
