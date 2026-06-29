import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerWatchCommand } from "../../src/commands/watch";
import { Command } from "commander";
import * as dbLib from "../../src/db/database";
import * as watchCore from "../../src/core/watch";
import * as watchConfig from "../../src/utils/watch-config";

vi.mock("../../src/db/database");
vi.mock("../../src/core/watch");
vi.mock("../../src/utils/watch-config");

describe("Watch Command CLI", () => {
  let program: Command;
  let mockExit: any;
  let mockLog: any;
  let mockWarn: any;
  let actionFn: (contractId: string | undefined, options: any) => Promise<void>;

  beforeEach(() => {
    program = new Command();

    vi.spyOn(Command.prototype, "action").mockImplementation(function (
      this: any,
      fn: any,
    ) {
      actionFn = fn;
      return this;
    });

    registerWatchCommand(program);

    mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
    mockLog = vi.spyOn(console, "log").mockImplementation(() => {});
    mockWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(dbLib, "getDatabase").mockReturnValue({} as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exits with 1 when watchContract returns success=false", async () => {
    vi.mocked(watchCore.watchContract).mockResolvedValue({
      success: false,
      error: "Failed to fetch instance",
    } as any);

    const validId = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";
    await actionFn(validId, { network: "testnet" });
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("prints contract details on success (with name)", async () => {
    vi.mocked(watchCore.watchContract).mockResolvedValue({
      success: true,
      instance: { remainingTTL: 100000 },
      wasm: { remainingTTL: 200000 },
    } as any);

    const validId = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";
    await actionFn(validId, { network: "testnet", name: "MyContract" });

    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("MyContract"));
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("testnet"));
  });

  it("prints WASM TTL when wasm entry exists", async () => {
    vi.mocked(watchCore.watchContract).mockResolvedValue({
      success: true,
      instance: { remainingTTL: 100000 },
      wasm: { remainingTTL: 50000 },
    } as any);

    const validId = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";
    await actionFn(validId, { network: "testnet" });

    expect(mockLog).toHaveBeenCalledWith(
      expect.stringContaining("WASM Code TTL"),
    );
  });

  it("prints WASM warning when present", async () => {
    vi.mocked(watchCore.watchContract).mockResolvedValue({
      success: true,
      instance: { remainingTTL: 100000 },
      wasm: null,
      wasmWarning: "WASM could not be fetched",
    } as any);

    const validId = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";
    await actionFn(validId, { network: "testnet" });

    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining("WASM could not be fetched"),
    );
  });

  it("passes correct options to watchContract", async () => {
    vi.mocked(watchCore.watchContract).mockResolvedValue({
      success: true,
      instance: { remainingTTL: 100000 },
      wasm: null,
    } as any);

    const validId = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";
    await actionFn(validId, {
      network: "mainnet",
      name: "TestContract",
      rpcUrl: "https://custom-rpc.com",
      storageKeys: "key1,key2",
      noIntrospection: true,
    });

    expect(watchCore.watchContract).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        contractId: validId,
        network: "mainnet",
        name: "TestContract",
        rpcUrl: "https://custom-rpc.com",
        storageKeys: "key1,key2",
        noIntrospection: true,
      }),
    );
  });

  it("exits with 1 when watchContract throws an error", async () => {
    vi.mocked(watchCore.watchContract).mockRejectedValue(
      new Error("Network timeout"),
    );

    const validId = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";
    await actionFn(validId, { network: "testnet" });
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("counts entries correctly (instance + wasm + storage keys)", async () => {
    vi.mocked(watchCore.watchContract).mockResolvedValue({
      success: true,
      instance: { remainingTTL: 100000 },
      wasm: { remainingTTL: 200000 },
    } as any);

    const validId = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";
    await actionFn(validId, { network: "testnet", storageKeys: "a,b,c" });

    // 1 (instance) + 1 (wasm) + 3 (storage keys) = 5
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("5"));
  });

  it("registers all contracts listed in a YAML file", async () => {
    const firstId = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";
    const secondId = "CD2R4QQV6KJ6P7JX5TURH6K7W2K4XQ6G5V5VJQ4X6UR6P6JQ6P2M4ABC";

    vi.mocked(watchConfig.loadWatchContractsFile).mockReturnValue([
      { contractId: firstId, name: "Alpha", network: "testnet" },
      {
        contractId: secondId,
        name: "Beta",
        network: "mainnet",
        rpcUrl: "https://rpc.example",
        storageKeys: ["key-1", "key-2"],
      },
    ]);

    vi.mocked(watchCore.watchContract)
      .mockResolvedValueOnce({
        success: true,
        instance: { remainingTTL: 100 },
        wasm: null,
      } as any)
      .mockResolvedValueOnce({
        success: true,
        instance: { remainingTTL: 200 },
        wasm: null,
      } as any);

    await actionFn(undefined, {
      fromFile: "contracts.yaml",
      network: "testnet",
    });

    expect(watchCore.watchContract).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        contractId: firstId,
        name: "Alpha",
        network: "testnet",
      }),
    );
    expect(watchCore.watchContract).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({
        contractId: secondId,
        name: "Beta",
        network: "mainnet",
        rpcUrl: "https://rpc.example",
        storageKeys: ["key-1", "key-2"],
      }),
    );
    expect(mockLog).toHaveBeenCalledWith(
      expect.stringContaining("Batch registration summary"),
    );
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("Alpha"));
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("Beta"));
  });

  it("prints a success and failure summary for batch registration and exits 1 when any contract fails", async () => {
    const firstId = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";
    const secondId = "CD2R4QQV6KJ6P7JX5TURH6K7W2K4XQ6G5V5VJQ4X6UR6P6JQ6P2M4ABC";

    vi.mocked(watchConfig.loadWatchContractsFile).mockReturnValue([
      { contractId: firstId, name: "Alpha", network: "testnet" },
      { contractId: secondId, name: "Beta", network: "mainnet" },
    ]);

    vi.mocked(watchCore.watchContract)
      .mockResolvedValueOnce({
        success: true,
        instance: { remainingTTL: 100 },
        wasm: null,
      } as any)
      .mockResolvedValueOnce({
        success: false,
        error: "Already registered on another network",
      } as any);

    await actionFn(undefined, {
      fromFile: "contracts.json",
      network: "testnet",
    });

    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("SUCCESS"));
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("FAILED"));
    expect(mockLog).toHaveBeenCalledWith(
      expect.stringContaining("1 succeeded"),
    );
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("1 failed"));
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
