import chalk from "chalk";

const AVG_LEDGER_CLOSE_TIME_IN_SECONDS = 5.5; // in seconds

export function convertLedgerCloseTimeToSeconds(ledgerCloseTime: number): number {
    return ledgerCloseTime * AVG_LEDGER_CLOSE_TIME_IN_SECONDS;
}

export function formatTimeToCloseLedger(ledgers: number): string {
  if (ledgers <= 0) {
    return "Ledger Expired";
  }

  const totalSeconds = convertLedgerCloseTimeToSeconds(ledgers);
  const minutes = Math.floor(totalSeconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

    if (days > 0) 
        return `~${days}d ${hours % 24}h`;
    else if (hours > 0) 
        return `~${hours}h ${minutes % 60}m`;
    else return `~${minutes}m ${totalSeconds % 60}s`;
}

export type TTLStatus = "ok" | "warning" | "critical" | "expired";

export function classifyTTL(remainingLedgers: number): TTLStatus {
    if (remainingLedgers <= 0) return "expired";
    if (remainingLedgers < 5000) return "critical";
    if (remainingLedgers < 20000) return "warning";
    return "ok";
}

export function statusIndicator(status: TTLStatus): string {
  switch (status) {
    case "ok": return chalk.bold.green("OK");
    case "warning": return chalk.bold.yellow("WARNING");
    case "critical": return chalk.bold.red("CRITICAL");
    case "expired": return chalk.bold.magenta("EXPIRED");
  }
}

export function formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

export function formatCpuInsns(insns: number): string {
    if (insns < 1000) return `${insns}`;
    if (insns < 1000000) return `${(insns / 1000).toFixed(2)}k`;
    return `${(insns / 1000000).toFixed(2)}m`;
}

export function formatContractID(contractID: string, maxLength: number = 16): string {
    if (contractID.length <= maxLength) return contractID;
    return `${contractID.slice(0, 8)}...${contractID.slice(-4)}`;
}
export function formatSecretKey(key: string | null): string | null {
    if (!key || key.startsWith("env:")) return key;
    if (key.startsWith("S") && key.length >= 8) {
        return `${key.slice(0, 4)}...${key.slice(-4)}`;
    }
    return key;
}
