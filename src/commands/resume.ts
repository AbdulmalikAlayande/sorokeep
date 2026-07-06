import { Command } from "commander";
import chalk from "chalk";
import { getDatabase } from "../db/database.js";
import { getContract, setContractActiveStatus } from "../db/repositories.js";
import { formatContractID } from "../utils/formatting.js";
import { getLogger } from "../logging/index.js";

const logger = getLogger().child({ component: "ResumeCommand" });

export const registerResumeCommand = (program: Command): void => {
    program
        .command("resume <contract-id>")
        .description("Resume daemon polling and alerting for a paused contract")
        .action(async (contractId: string) => {
            try {
                const db = getDatabase();
                const contract = getContract(db, contractId);

                if (!contract) {
                    console.log(chalk.red(`Contract ${formatContractID(contractId)} is not being watched.`));
                    process.exit(1);
                    return;
                }

                setContractActiveStatus(db, contractId, true);
                console.log(chalk.green(`Successfully resumed monitoring for ${formatContractID(contractId)}.`));
            } catch (error: any) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                logger.error("Resume command failed", { error: errorMessage });
                console.log(chalk.red(`Failed to resume contract: ${errorMessage}`));
                process.exit(1);
            }
        });
};
