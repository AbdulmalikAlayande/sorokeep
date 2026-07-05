import { xdr, scValToNative } from "@stellar/stellar-sdk";

/**
 * Translate a Soroban `SCVal` into a JSON-safe representation.
 *
 * Design goals:
 * - Recursively translate nested vectors/maps.
 * - Avoid precision loss: large ints are always returned as strings.
 * - Produce human-readable tokens for symbol/address.
 */
export function scvalToJSON(val: xdr.ScVal): any {
  let native;
  try {
    native = scValToNative(val);
  } catch (e) {
    return { unsupported: val.switch().name };
  }
  return serializeBigInts(native);
}

function serializeBigInts(obj: any): any {
  if (typeof obj === "bigint") {
    return obj.toString(10);
  }
  if (Array.isArray(obj)) {
    return obj.map(serializeBigInts);
  }
  if (obj !== null && typeof obj === "object") {
    const res: any = {};
    for (const [k, v] of Object.entries(obj)) {
      res[k] = serializeBigInts(v);
    }
    return res;
  }
  return obj;
}
