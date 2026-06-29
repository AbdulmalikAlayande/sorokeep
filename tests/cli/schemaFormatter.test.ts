import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadSchema, applySchema, loadAndApplySchema } from "../../src/cli/schemaFormatter";

describe("schemaFormatter", () => {
  it("loadSchema loads and validates a valid dictionary JSON", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sorokeep-schema-"));
    const schemaPath = path.join(tmpDir, "schema.json");
    fs.writeFileSync(
      schemaPath,
      JSON.stringify({ raw_key_123: "UserBalance" }),
      "utf8",
    );

    const schema = loadSchema(schemaPath);
    expect(schema).toEqual({ raw_key_123: "UserBalance" });
  });

  it("loadSchema throws descriptive error when schema file is missing", () => {
    const missing = path.join(os.tmpdir(), `sorokeep-schema-missing-${Date.now()}.json`);
    expect(() => loadSchema(missing)).toThrowError(
      /Schema configuration error: schema file not found at '.*'|schema file not found/i,
    );
  });

  it("loadSchema throws descriptive error when JSON is malformed", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sorokeep-schema-"));
    const schemaPath = path.join(tmpDir, "schema.json");
    fs.writeFileSync(schemaPath, "{ this is not json", "utf8");

    expect(() => loadSchema(schemaPath)).toThrowError(
      /Schema configuration error: malformed JSON in schema file/i,
    );
  });

  it("loadSchema throws descriptive error when structure is invalid", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sorokeep-schema-"));
    const schemaPath = path.join(tmpDir, "schema.json");
    fs.writeFileSync(schemaPath, JSON.stringify({ a: 123 }), "utf8");

    expect(() => loadSchema(schemaPath)).toThrowError(
      /Schema configuration error: schema value for key 'a' must be a string label/i,
    );
  });

  it("applySchema deep-traverses and substitutes matching dictionary keys and string values", () => {
    const schema = {
      raw_key_123: "UserBalance",
      "raw symbol": "DeveloperName",
    } as const;

    const input = {
      raw_key_123: {
        value: "raw symbol",
        untouched: "raw_other",
      },
      arr: ["raw symbol", { raw_key_123: "raw_key_123" }],
    };

    const output = applySchema(input, schema);

    expect(output).toEqual({
      UserBalance: {
        value: "DeveloperName",
        untouched: "raw_other",
      },
      arr: ["DeveloperName", { UserBalance: "UserBalance" }],
    });
  });

  it("applySchema returns original object untouched when schema is empty", () => {
    const input = { raw_key_123: "raw_key_123" };
    const output = applySchema(input, {});
    expect(output).toBe(input);
  });

  it("loadAndApplySchema returns original object when no schemaPath is passed", () => {
    const input = { raw_key_123: "raw_key_123" };
    const output = loadAndApplySchema(input);
    expect(output).toBe(input);
  });

  it("loadAndApplySchema leaves data unchanged when no keys match", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sorokeep-schema-"));
    const schemaPath = path.join(tmpDir, "schema.json");
    fs.writeFileSync(schemaPath, JSON.stringify({ different_key: "SomeLabel" }), "utf8");

    const input = { raw_key_123: "raw_key_123", nested: { other: "raw_key_123" } };
    const output = loadAndApplySchema(input, schemaPath);

    expect(output).toEqual(input);
  });
});
