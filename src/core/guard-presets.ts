/**
 * Extension policy presets for the `sorokeep guard` command.
 *
 * These named presets translate Soroban's rent model into approachable choices.
 * Each preset is a fixed { targetTtl, threshold } pair. They resolve directly
 * to the existing --target-ttl / --threshold parameters — no core logic change.
 *
 * Ledger timing reference (approximate):
 *   ~17,280 ledgers ≈ 1 day  (at ~5-second average close time)
 *   ~120,960 ledgers ≈ 7 days
 *   ~518,400 ledgers ≈ 30 days
 *
 * Preset summary:
 *
 * | Preset       | Target TTL      | Threshold      | Safety margin | Cost  |
 * |--------------|-----------------|----------------|---------------|-------|
 * | conservative | 518,400 (~30d)  | 103,680 (~6d)  | Wide (6 days) | High  |
 * | balanced     | 100,000 (~5.8d) | 20,000 (~1.2d) | Medium        | Med   |
 * | aggressive   | 51,840  (~3d)   | 8,640  (~12h)  | Narrow (12h)  | Low   |
 */

export type PresetName = "conservative" | "balanced" | "aggressive";

export interface GuardPreset {
    /** Human-readable name of the preset. */
    name: PresetName;
    /** One-line description of the tradeoff. */
    description: string;
    /**
     * Target TTL in ledgers — the value the contract's TTL is extended to.
     * Higher = fewer extensions needed = higher cost per cycle but less frequent.
     */
    targetTtl: number;
    /**
     * Threshold in ledgers — auto-extension triggers when remaining TTL falls below this.
     * Higher threshold = more lead time before archival = safer but more frequent extensions.
     */
    threshold: number;
}

export const GUARD_PRESETS: Record<PresetName, GuardPreset> = {
    /**
     * Conservative — maximum safety margin, highest cost.
     *
     * Extends to 30 days and triggers 6 days before expiry.
     * Ideal for production contracts where downtime is unacceptable.
     * Minimizes the risk of missed extensions due to daemon downtime or RPC issues.
     */
    conservative: {
        name: "conservative",
        description: "Max safety margin (~6d buffer). Best for production — higher cost, extends early.",
        targetTtl: 518_400, // ~30 days
        threshold: 103_680, // ~6 days
    },

    /**
     * Balanced — the factory default, good for most use cases.
     *
     * Matches the existing default values (--target-ttl 100000 --threshold 20000).
     * A reasonable middle ground between cost and safety for testnet and staging.
     */
    balanced: {
        name: "balanced",
        description: "Sensible defaults (~1.2d buffer). Good for staging and most mainnet contracts.",
        targetTtl: 100_000, // ~5.8 days
        threshold: 20_000,  // ~1.2 days
    },

    /**
     * Aggressive — minimum cost, thinnest safety margin.
     *
     * Extends to 3 days and triggers only 12 hours before expiry.
     * Suitable for contracts that are actively monitored and where extension
     * cost matters more than safety margin (e.g. long-running testnet experiments).
     * Not recommended for production without additional monitoring.
     */
    aggressive: {
        name: "aggressive",
        description: "Minimal cost (~12h buffer). Suitable for testnet or actively monitored contracts.",
        targetTtl: 51_840, // ~3 days
        threshold: 8_640,  // ~12 hours
    },
};

/** Ordered list of valid preset names (used for CLI help text). */
export const PRESET_NAMES: PresetName[] = ["conservative", "balanced", "aggressive"];

/**
 * Look up a preset by name.
 *
 * @param name - One of "conservative", "balanced", or "aggressive".
 * @returns The GuardPreset object, or undefined if the name is not recognised.
 */
export function getPreset(name: string): GuardPreset | undefined {
    return GUARD_PRESETS[name as PresetName];
}
