import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Command } from "commander";
import type Database from "better-sqlite3";
import { getDatabaseForTesting } from "../../src/db/database";
import { registerCloneConfigCommand } from "../../src/commands/clone-config";
import {
  insertContract,
  upsertExtensionPolicy,
  insertAlertConfig,
  addTargetToAlertConfig,
  getAlertConfigsForContract,
  getExtensionPolicy,
  getAlertConfigTargets,
} from "../../src/db/repositories";

let mockDb: Database.Database;

vi.mock("../../src/db/database.js", async (importOriginal) => {
  const actual = await importOriginal() as any;
  return { ...actual, getDatabase: () => mockDb };
});

describe("clone-config command", () => {
  let program: Command;
  let consoleLogMock: ReturnType<typeof vi.spyOn>;
  let consoleErrorMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockDb = getDatabaseForTesting();

    program = new Command();
    registerCloneConfigCommand(program);
    program.exitOverride();
    program.configureOutput({
      writeOut: () => {},
      writeErr: () => {},
    });

    consoleLogMock = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorMock = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fails if source contract does not exist", async () => {
    await expect(
      program.parseAsync(["node", "test", "clone-config", "C_SOURCE", "C_TARGET"]),
    ).rejects.toThrow();
    expect(consoleErrorMock).toHaveBeenCalledWith(expect.stringContaining("Source contract C_SOURCE not found"));
  });

  it("fails if target contract does not exist", async () => {
    insertContract(mockDb, { id: "C_SOURCE", network: "testnet" });
    await expect(
      program.parseAsync(["node", "test", "clone-config", "C_SOURCE", "C_TARGET"]),
    ).rejects.toThrow();
    expect(consoleErrorMock).toHaveBeenCalledWith(expect.stringContaining("Target contract C_TARGET not found"));
  });

  it("clones extension policy and alert configs from source to target", async () => {
    insertContract(mockDb, { id: "C_SOURCE", network: "testnet" });
    insertContract(mockDb, { id: "C_TARGET", network: "testnet" });

    upsertExtensionPolicy(mockDb, {
      contract_id: "C_SOURCE",
      enabled: true,
      target_ttl_ledgers: 1000,
      extend_when_below_ledgers: 500,
      keypair_public: "GABC",
    });

    const ac1 = insertAlertConfig(mockDb, {
      contract_id: "C_SOURCE",
      channel_type: "discord",
      channel_target: "chan1",
      threshold_ledgers: 200,
    });
    addTargetToAlertConfig(mockDb, ac1, "discord", "chan1");

    insertAlertConfig(mockDb, {
      contract_id: "C_SOURCE",
      channel_type: "email",
      channel_target: "test@test.com",
      threshold_ledgers: 300,
      quiet_hours_start: "22:00",
    });

    await program.parseAsync(["node", "test", "clone-config", "C_SOURCE", "C_TARGET"]);

    const targetPolicy = getExtensionPolicy(mockDb, "C_TARGET");
    expect(targetPolicy).toBeDefined();
    expect(targetPolicy?.target_ttl_ledgers).toBe(1000);
    expect(targetPolicy?.extend_when_below_ledgers).toBe(500);
    expect(targetPolicy?.keypair_public).toBe("GABC");

    const targetConfigs = getAlertConfigsForContract(mockDb, "C_TARGET");
    expect(targetConfigs).toHaveLength(2);

    const targetAc1 = targetConfigs.find((c) => c.channel_type === "discord");
    expect(targetAc1?.threshold_ledgers).toBe(200);
    const targets1 = getAlertConfigTargets(mockDb, targetAc1!.id);
    expect(targets1).toHaveLength(1);
    expect(targets1[0]!.channel_target).toBe("chan1");

    const targetAc2 = targetConfigs.find((c) => c.channel_type === "email");
    expect(targetAc2?.threshold_ledgers).toBe(300);
    expect(targetAc2?.quiet_hours_start).toBe("22:00");
  });

  it("appends to alert configs if target already has some, and overwrites guard policy", async () => {
    insertContract(mockDb, { id: "C_SOURCE", network: "testnet" });
    insertContract(mockDb, { id: "C_TARGET", network: "testnet" });

    upsertExtensionPolicy(mockDb, {
      contract_id: "C_SOURCE",
      target_ttl_ledgers: 5000,
      extend_when_below_ledgers: 2500,
    });
    insertAlertConfig(mockDb, {
      contract_id: "C_SOURCE",
      channel_type: "slack",
      channel_target: "source-chan",
      threshold_ledgers: 100,
    });

    upsertExtensionPolicy(mockDb, {
      contract_id: "C_TARGET",
      target_ttl_ledgers: 10,
      extend_when_below_ledgers: 5,
    });
    insertAlertConfig(mockDb, {
      contract_id: "C_TARGET",
      channel_type: "slack",
      channel_target: "target-chan",
      threshold_ledgers: 999,
    });

    await program.parseAsync(["node", "test", "clone-config", "C_SOURCE", "C_TARGET"]);

    const targetPolicy = getExtensionPolicy(mockDb, "C_TARGET");
    expect(targetPolicy?.target_ttl_ledgers).toBe(5000);

    const targetConfigs = getAlertConfigsForContract(mockDb, "C_TARGET");
    expect(targetConfigs).toHaveLength(2);
    expect(targetConfigs.map((c) => c.channel_target).sort()).toEqual(["source-chan", "target-chan"]);

    expect(consoleLogMock).toHaveBeenCalledWith(expect.stringContaining("Overwrote existing guard policy"));
    expect(consoleLogMock).toHaveBeenCalledWith(expect.stringContaining("Appended 1 alert config(s)"));
  });
});
