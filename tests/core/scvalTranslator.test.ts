import { describe, it, expect } from "vitest";
import { nativeToScVal } from "@stellar/stellar-sdk";

import { scvalToJSON } from "../../src/core/scvalTranslator";

describe("SCVal translator (SCVal -> JSON)", () => {
  it("translates primitive Symbol, String, Bool, Address", () => {
    const sym = nativeToScVal("hello", { type: "symbol" });
    const str = nativeToScVal("world", { type: "string" });
    const bln = nativeToScVal(true, { type: "bool" });
    const addr = nativeToScVal("GA352JVPP6DKOPFVZMAHJFUX6RPTKJE3TUPSQABR53E2Z4SIDIDSN4NU", { type: "address" });

    expect(scvalToJSON(sym)).toBe("hello");
    expect(scvalToJSON(str)).toBe("world");
    expect(scvalToJSON(bln)).toBe(true);
    expect(scvalToJSON(addr)).toBe(
      "GA352JVPP6DKOPFVZMAHJFUX6RPTKJE3TUPSQABR53E2Z4SIDIDSN4NU",
    );
  });

  it("converts i/u 64 and i/u 128 into precision-safe strings", () => {
    const i64 = nativeToScVal(-9223372036854775808n, { type: "i64" });
    const u64 = nativeToScVal(18446744073709551615n, { type: "u64" });
    const i128 = nativeToScVal(
      -170141183460469231731687303715884105728n,
      { type: "i128" }
    );
    const u128 = nativeToScVal(
      340282366920938463463374607431768211455n,
      { type: "u128" }
    );

    expect(scvalToJSON(i64)).toBe("-9223372036854775808");
    expect(scvalToJSON(u64)).toBe("18446744073709551615");
    expect(scvalToJSON(i128)).toBe(
      "-170141183460469231731687303715884105728",
    );
    expect(scvalToJSON(u128)).toBe(
      "340282366920938463463374607431768211455",
    );
  });

  it("translates deeply nested vectors (scvVec)", () => {
    const v = nativeToScVal([
      nativeToScVal("a", { type: "symbol" }),
      [nativeToScVal(123n, { type: "i64" }), false],
    ]);

    expect(scvalToJSON(v)).toEqual(["a", ["123", false]]);
  });

  it("translates maps (scvMap) into JSON objects", () => {
    const m = nativeToScVal({
      k1: "v1",
      k2: nativeToScVal(5n, { type: "i64" })
    });

    expect(scvalToJSON(m)).toEqual({ k1: "v1", k2: "5" });
  });

  it("translates mixed nested structures (vector + map + primitives)", () => {
    const input = nativeToScVal([
      {
        flag: true,
        addr: nativeToScVal("GA352JVPP6DKOPFVZMAHJFUX6RPTKJE3TUPSQABR53E2Z4SIDIDSN4NU", { type: "address" })
      },
      nativeToScVal(42n, { type: "u128" })
    ]);

    expect(scvalToJSON(input)).toEqual([
      { flag: true, addr: "GA352JVPP6DKOPFVZMAHJFUX6RPTKJE3TUPSQABR53E2Z4SIDIDSN4NU" },
      "42",
    ]);
  });
});


