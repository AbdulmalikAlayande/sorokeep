import { Command } from "commander";
import { getDatabase } from "../db/database.js";
import {
  getCompletionSuggestions,
  renderBashCompletionScript,
  renderZshCompletionScript,
} from "../core/completion.js";

export function registerCompletionCommand(program: Command): void {
  program
    .command("completion")
    .description("Generate or query shell completion suggestions")
    .option("--script <shell>", "Generate a completion script for bash or zsh")
    .option("--query", "Query completion suggestions for the current command line")
    .option("--cursor <index>", "Cursor position for the current word", (val) => parseInt(val, 10))
    .argument("[words...]", "Current command line words")
    .action((words: string[], options: { script?: string; query?: boolean; cursor?: number }) => {
      if (options.query) {
        const cursor = Number.isInteger(options.cursor) ? options.cursor! : words.length - 1;
        const db = getDatabase();
        const suggestions = getCompletionSuggestions(db, ["sorokeep", ...words], cursor);
        process.stdout.write(suggestions.join("\n"));
        return;
      }

      if (options.script) {
        if (options.script === "bash") {
          process.stdout.write(renderBashCompletionScript());
          return;
        }
        if (options.script === "zsh") {
          process.stdout.write(renderZshCompletionScript());
          return;
        }
        console.error("Unsupported shell for completion script. Use 'bash' or 'zsh'.");
        process.exit(1);
      }

      process.stdout.write("Generate shell completion scripts or query suggestions for shell integration.\n");
      process.stdout.write("Use '--script bash' or '--script zsh' to print a completion script.\n");
      process.stdout.write("Use '--query --cursor <index> [words...]' to query suggestions.\n");
    });
}
