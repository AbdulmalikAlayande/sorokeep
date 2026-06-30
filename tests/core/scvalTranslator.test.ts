import { describe, it, expect } from "vitest";
import { Address, SCVal } from "@stellar/stellar-sdk";

import { scvalToJSON } from "../../src/core/scvalTranslator";

describe("SCVal translator (SCVal -> JSON)", () => {
  it("translates primitive Symbol, String, Bool, Address", () => {
    const sym = SCVal.scvSymbol("hello");
    const str = SCVal.scvString("world");
    const bln = SCVal.scvBool(true);
    const addr = SCVal.scvAddress(new Address("GBB6GZ4X7WJ2X2K2Q4QG7YQK3KJ7G2Q3K3Q3K3Q3K3Q3Q3Q3K3Q3Q3Q3"));

    expect(scvalToJSON(sym)).toBe("hello");
    expect(scvalToJSON(str)).toBe("world");
    expect(scvalToJSON(bln)).toBe(true);
    expect(scvalToJSON(addr)).toBe(
      "GBB6GZ4X7WJ2X2K2Q4QG7YQK3KJ7G2Q3K3Q3K3Q3K3Q3Q3Q3K3Q3Q3Q3",
    );
  });

  it("converts i/u 64 and i/u 128 into precision-safe strings", () => {
    const i64 = SCVal.scvI64(-9223372036854775808n);
    const u64 = SCVal.scvU64(18446744073709551615n);
    const i128 = SCVal.scvI128(
      -170141183460469231731687303715884105728n,
    );
    const u128 = SCVal.scvU128(
      340282366920938463463374607431768211455n,
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
    const v = SCVal.scvVec([
      SCVal.scvSymbol("a"),
      SCVal.scvVec([SCVal.scvI64(123n), SCVal.scvBool(false)]),
    ]);

    expect(scvalToJSON(v)).toEqual(["a", ["123", false]]);
  });

  it("translates maps (scvMap) into JSON objects", () => {
    const m = SCVal.scvMap([
      [SCVal.scvSymbol("k1"), SCVal.scvString("v1")],
      [SCVal.scvSymbol("k2"), SCVal.scvI64(5n)],
    ]);

    expect(scvalToJSON(m)).toEqual({ k1: "v1", k2: "5" });
  });

  it("translates mixed nested structures (vector + map + primitives)", () => {
    const input = SCVal.scvVec([
      SCVal.scvMap([
        [SCVal.scvSymbol("flag"), SCVal.scvBool(true)],
        [SCVal.scvSymbol("addr"),
          SCVal.scvAddress(
            new Address("GBB6GZ4X7WJ2X2K2Q4QG7YQK3KJ7G2Q3K3Q3K3Q3K3Q3Q3Q3K3Q3Q3Q3"),
          )
        ],
      ]),
      SCVal.scvU128(42n),
    ]);

    expect(scvalToJSON(input)).toEqual([
      { flag: true, addr: "GBB6GZ4X7WJ2X2K2Q4QG7YQK3KJ7G2Q3K3Q3K3Q3K3Q3Q3Q3K3Q3Q3Q3" },
      "42",
    ]);
  });
});

