import fs from "node:fs";

export type SchemaDictionary = Record<string, string>;

function normalizeSchemaCandidate(input: unknown): SchemaDictionary {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(
      "Schema configuration error: schema JSON must be a top-level object mapping raw keys to labels",
    );
  }

  const candidate = input as Record<string, unknown>;
  const out: SchemaDictionary = {};

  for (const [k, v] of Object.entries(candidate)) {
    if (typeof v !== "string") {
      throw new Error(
        `Schema configuration error: schema value for key '${k}' must be a string label`,
      );
    }
    out[k] = v;
  }

  return out;
}

export function loadSchema(schemaPath: string): SchemaDictionary {
  try {
    const raw = fs.readFileSync(schemaPath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Schema configuration error: malformed JSON in schema file: ${msg}`, { cause: err });
    }

    return normalizeSchemaCandidate(parsed);
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr?.code === "ENOENT") {
      throw new Error(
        `Schema configuration error: schema file not found at '${schemaPath}'`,
        { cause: nodeErr ?? err }
      );
    }
    const msg = nodeErr?.message ?? String(err);
    throw new Error(`Schema configuration error: failed to load schema file: ${msg}`, { cause: nodeErr ?? err });
  }
}

function applySchemaToValue(value: unknown, schema: SchemaDictionary): unknown {
  if (typeof value === "string") {
    return schema[value] ?? value;
  }

  if (Array.isArray(value)) {
    return value.map((v) => applySchemaToValue(v, schema));
  }

  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(obj)) {
      const nextKey = schema[key] ?? key;
      out[nextKey] = applySchemaToValue(v, schema);
    }
    return out;
  }

  return value;
}

export function applySchema(data: any, schema: SchemaDictionary): any {
  if (!schema || Object.keys(schema).length === 0) return data;
  return applySchemaToValue(data, schema);
}

/**
 * Wrapper used by CLI inspect formatting: loads schema when schemaPath is provided.
 *
 * - If schemaPath is undefined, returns schema map as undefined (caller should skip transformation)
 * - If schemaPath is provided, loads+validates schema and applies translation to `data`.
 */
export function loadAndApplySchema(data: any, schemaPath?: string): any {
  if (!schemaPath) return data;
  const schema = loadSchema(schemaPath);
  return applySchema(data, schema);
}

