import { Address, SCVal } from "@stellar/stellar-sdk";

/**
 * Translate a Soroban `SCVal` into a JSON-safe representation.
 *
 * Design goals:
 * - Recursively translate nested vectors/maps.
 * - Avoid precision loss: large ints are always returned as strings.
 * - Produce human-readable tokens for symbol/address.
 */
export function scvalToJSON(val: SCVal): any {
  // `switch()` is the discriminant helper on the SDK `SCVal` class.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sw: any = (val as any).switch();
  const type = sw.type;
  const value = sw.value;

  switch (type) {
    case "symbol": {
      // `value` is a string
      return value;
    }

    case "string": {
      return value;
    }

    case "bool": {
      return value;
    }

    case "address": {
      // The SDK returns an `Address` instance.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const addr: Address = value;
      return addr.toString();
    }

    case "i64":
    case "u64":
    case "i128":
    case "u128": {
      // SDK numeric values are represented as bigint.
      // Always stringify to preserve absolute precision.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const n: bigint = value;
      return n.toString(10);
    }

    case "vec": {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const items: SCVal[] = value;
      return items.map((x) => scvalToJSON(x));
    }

    case "map": {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const pairs: Array<[SCVal, SCVal]> = value;

      const out: Record<string, any> = {};
      for (const [k, v] of pairs) {
        const key = scvalToJSON(k);
        if (typeof key !== "string") {
          // Enforce a JSON-object-friendly key. Fallback to tokenised string.
          out[String(key)] = scvalToJSON(v);
        } else {
          out[key] = scvalToJSON(v);
        }
      }
      return out;
    }

    default: {
      // If new SCVal variants appear in the SDK, fail in a controlled way.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { unsupported: type, value } as any;
    }
  }
}
