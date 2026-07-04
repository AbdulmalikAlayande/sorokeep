import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

const watchContractConfigSchema = z.object({
    contractId: z.string().min(1),
    name: z.string().min(1).optional(),
    network: z.string().min(1),
    rpcUrl: z.string().min(1).optional(),
    storageKeys: z.array(z.string().min(1)).optional(),
    noIntrospection: z.boolean().optional(),
});

const watchContractsFileSchema = z.union([
    z.array(watchContractConfigSchema),
    z.object({
        contracts: z.array(watchContractConfigSchema),
    }),
]);

export type WatchContractFileEntry = z.infer<typeof watchContractConfigSchema>;

export function loadWatchContractsFile(filePath: string): WatchContractFileEntry[] {
    const raw = fs.readFileSync(filePath, "utf-8");
    const ext = path.extname(filePath).toLowerCase();

    let parsed: unknown;
    if (ext === ".json") {
        parsed = JSON.parse(raw);
    } else {
        parsed = YAML.parse(raw);
    }

    const validated = watchContractsFileSchema.parse(parsed);
    return Array.isArray(validated) ? validated : validated.contracts;
}
