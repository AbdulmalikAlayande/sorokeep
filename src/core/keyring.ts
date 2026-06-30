import { Keypair } from "@stellar/stellar-sdk";

export interface KeyResolver {
    resolve(): Promise<string | undefined>;
}

export class EnvResolver implements KeyResolver {
    constructor(private envVarName: string) {}

    async resolve(): Promise<string | undefined> {
        return process.env[this.envVarName];
    }
}

export class KeychainResolver implements KeyResolver {
    constructor(private service: string, private account: string) {}

    async resolve(): Promise<string | undefined> {
        try {
            const { execSync } = await import("child_process");
            if (process.platform === "darwin") {
                const out = execSync(`security find-generic-password -s "${this.service}" -a "${this.account}" -w`, { stdio: "pipe" });
                return out.toString().trim();
            }
            // Add other OS keychain support if needed
            return undefined;
        } catch (error) {
            return undefined;
        }
    }
}

export class FileResolver implements KeyResolver {
    constructor(private filePath: string) {}

    async resolve(): Promise<string | undefined> {
        try {
            const fs = await import("fs/promises");
            const content = await fs.readFile(this.filePath, "utf-8");
            return content.trim() || undefined;
        } catch (error) {
            return undefined;
        }
    }
}

export class RawResolver implements KeyResolver {
    constructor(private secretKey: string) {}

    async resolve(): Promise<string | undefined> {
        return this.secretKey;
    }
}

export class KeyChain {
    resolvers: KeyResolver[] = [];

    addResolver(resolver: KeyResolver) {
        this.resolvers.push(resolver);
    }

    async resolve(): Promise<string | undefined> {
        for (const resolver of this.resolvers) {
            const key = await resolver.resolve();
            if (key) {
                // Validate signature capabilities of resolved keys
                try {
                    const kp = Keypair.fromSecret(key);
                    const testData = Buffer.from("validate");
                    const sig = kp.sign(testData);
                    if (kp.verify(testData, sig)) {
                        return key;
                    }
                } catch (e) {
                    // Invalid key format, try next resolver
                }
            }
        }

        return undefined;
    }
}

export function parseKeypairSource(source: string): KeyResolver | undefined {
    if (source.startsWith("env:")) {
        return new EnvResolver(source.slice(4));
    }
    if (source.startsWith("file:")) {
        return new FileResolver(source.slice(5));
    }
    if (source.startsWith("keychain:")) {
        const parts = source.slice(9).split(":");
        if (parts.length >= 2) {
            return new KeychainResolver(parts[0], parts.slice(1).join(":"));
        }
    }
    
    // Attempt to parse as raw secret if it starts with 'S' and is 56 chars
    if (source.startsWith("S") && source.length === 56) {
        return new RawResolver(source);
    }
    
    return undefined;
}
