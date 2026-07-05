import type Database from "better-sqlite3";
import { getAllContracts } from "../db/repositories.js";

export const TOP_LEVEL_COMMANDS = [
  "watch",
  "status",
  "check",
  "daemon",
  "alerts",
  "guard",
  "costs",
  "resources",
  "restore",
  "channels",
  "completion",
];

export const ALERTS_SUBCOMMANDS = ["add", "list", "remove", "test", "history"];
export const CHANNELS_SUBCOMMANDS = ["add", "list", "fund"];
export const STATUS_CONTRACT_COMMANDS = ["status", "check", "resources", "costs", "guard", "restore"];

export function getCompletionSuggestions(
  db: Database.Database,
  words: string[],
  cursorIndex: number,
): string[] {
  if (words.length <= 1 || cursorIndex <= 1) {
    return TOP_LEVEL_COMMANDS;
  }

  const normalizedWords = words.slice(1, cursorIndex + 1);
  const firstCommand = normalizedWords[0];

  if (firstCommand === "alerts") {
    if (cursorIndex === 2) {
      return ALERTS_SUBCOMMANDS;
    }
    return [];
  }

  if (firstCommand === "channels") {
    if (cursorIndex === 2) {
      return CHANNELS_SUBCOMMANDS;
    }
    return [];
  }

  if (STATUS_CONTRACT_COMMANDS.includes(firstCommand) && cursorIndex === 2) {
    const contracts = getAllContracts(db).map((contract) => contract.id);
    return contracts;
  }

  return TOP_LEVEL_COMMANDS.filter((cmd) => cmd.startsWith(normalizedWords[0] ?? ""));
}

export function renderBashCompletionScript(): string {
  return `#!/usr/bin/env bash
_sorokeep_complete() {
  local cur prev words cword
  _init_completion -n : || return

  local suggestions
  suggestions=$(sorokeep completion --query --cursor "$cword" "\${words[@]}" 2>/dev/null)
  COMPREPLY=( $(compgen -W "$suggestions" -- "$cur") )
}
complete -F _sorokeep_complete sorokeep
`;
}

export function renderZshCompletionScript(): string {
  return `#compdef sorokeep

_sorokeep() {
  local -a suggestions
  local -a words
  words=( $words )
  local current_word=\${words[CURRENT]}
  suggestions=( \${(f)$(sorokeep completion --query --cursor "$CURRENT" "\${words[@]}")} )
  _describe 'values' suggestions
}

compdef _sorokeep sorokeep
`;
}
