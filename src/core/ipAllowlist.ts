import ipaddr from "ipaddr.js";
import { getLogger } from "../logging/index.js";

const logger = getLogger().child({ component: "IpAllowlist" });

type ParsedRange = [ipaddr.IPv4 | ipaddr.IPv6, number];

/**
 * Build an `isAllowed(remoteAddress)` predicate from a list of bare IPs or
 * CIDR ranges. Bare IPs are treated as an exact match (/32 for IPv4, /128
 * for IPv6). Unset/undefined always allows — that's the "no allowlist
 * configured" case, handled by the caller before this is even invoked.
 */
export function checkIpAllowlist(allowedIps: string[]): (remoteAddressStr?: string) => boolean {
    const parsedRanges = allowedIps
        .map((ipStr): ParsedRange | null => {
            try {
                if (ipStr.includes("/")) {
                    return ipaddr.parseCIDR(ipStr);
                }
                const parsed = ipaddr.parse(ipStr);
                const prefix = parsed.kind() === "ipv4" ? 32 : 128;
                return ipaddr.parseCIDR(`${ipStr}/${prefix}`);
            } catch {
                logger.warn(`Invalid IP/CIDR in allowedIps: ${ipStr}`);
                return null;
            }
        })
        .filter((r): r is ParsedRange => r !== null);

    return function isAllowed(remoteAddressStr?: string): boolean {
        if (!remoteAddressStr) return false;

        try {
            let remoteAddress = ipaddr.parse(remoteAddressStr);
            if (remoteAddress.kind() === "ipv6" && (remoteAddress as ipaddr.IPv6).isIPv4MappedAddress()) {
                remoteAddress = (remoteAddress as ipaddr.IPv6).toIPv4Address();
            }
            // ipaddr.js's match() overloads require both sides to be the same
            // IP kind — TS can't resolve the union call, and mismatched kinds
            // (e.g. an IPv4 address against an IPv6 range) simply never match
            // at runtime anyway, so filter to same-kind ranges first.
            return parsedRanges.some(([rangeAddr, prefix]) =>
                rangeAddr.kind() === remoteAddress.kind() &&
                (remoteAddress.kind() === "ipv4"
                    ? (remoteAddress as ipaddr.IPv4).match(rangeAddr as ipaddr.IPv4, prefix)
                    : (remoteAddress as ipaddr.IPv6).match(rangeAddr as ipaddr.IPv6, prefix)),
            );
        } catch {
            return false;
        }
    };
}
