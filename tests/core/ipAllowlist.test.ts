import { describe, it, expect } from "vitest";
import { checkIpAllowlist } from "../../src/core/ipAllowlist.js";

describe("checkIpAllowlist", () => {
    it("allows an exact IPv4 match", () => {
        const isAllowed = checkIpAllowlist(["203.0.113.5"]);
        expect(isAllowed("203.0.113.5")).toBe(true);
    });

    it("rejects an IPv4 not in the allowlist", () => {
        const isAllowed = checkIpAllowlist(["203.0.113.5"]);
        expect(isAllowed("198.51.100.1")).toBe(false);
    });

    it("allows an IPv4 within a CIDR range", () => {
        const isAllowed = checkIpAllowlist(["10.0.0.0/8"]);
        expect(isAllowed("10.1.2.3")).toBe(true);
        expect(isAllowed("10.255.255.255")).toBe(true);
    });

    it("rejects an IPv4 outside a CIDR range", () => {
        const isAllowed = checkIpAllowlist(["10.0.0.0/8"]);
        expect(isAllowed("11.0.0.1")).toBe(false);
    });

    it("resolves an IPv4-mapped IPv6 address against an IPv4 allowlist entry", () => {
        const isAllowed = checkIpAllowlist(["127.0.0.1"]);
        expect(isAllowed("::ffff:127.0.0.1")).toBe(true);
    });

    it("allows an exact IPv6 match", () => {
        const isAllowed = checkIpAllowlist(["::1"]);
        expect(isAllowed("::1")).toBe(true);
    });

    it("returns false for an unparseable remote address", () => {
        const isAllowed = checkIpAllowlist(["10.0.0.0/8"]);
        expect(isAllowed("not-an-ip")).toBe(false);
    });

    it("returns false when no remote address is provided", () => {
        const isAllowed = checkIpAllowlist(["10.0.0.0/8"]);
        expect(isAllowed(undefined)).toBe(false);
    });

    it("skips an invalid CIDR entry without throwing, still enforcing the valid ones", () => {
        const isAllowed = checkIpAllowlist(["not-a-real-ip/8", "10.0.0.0/8"]);
        expect(isAllowed("10.1.1.1")).toBe(true);
        expect(isAllowed("192.168.1.1")).toBe(false);
    });

    it("matches against multiple allowlist entries", () => {
        const isAllowed = checkIpAllowlist(["10.0.0.0/8", "192.168.0.0/16"]);
        expect(isAllowed("10.1.1.1")).toBe(true);
        expect(isAllowed("192.168.5.5")).toBe(true);
        expect(isAllowed("172.16.0.1")).toBe(false);
    });
});
