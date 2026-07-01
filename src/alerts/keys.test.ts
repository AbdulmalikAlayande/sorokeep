import { describe, it, expect, vi, beforeEach } from "vitest";

// ==========================================
// --- 1. CORE IMPLEMENTATION CODE ---
// ==========================================

export interface KeychainStore {
  saveKey(name: string, secret: string): Promise<boolean>;
  listKeys(): Promise<string[]>;
}

/**
 * Keytar-backed system credential manager layer
 */
export class SecureKeypairStore implements KeychainStore {
  private serviceName = "sorokeep-keys";
  private keytar: any;

  constructor(keytarMock?: any) {
    // Fallback to allow mock injection during test environments safely
    this.keytar = keytarMock;
  }

  async saveKey(name: string, secret: string): Promise<boolean> {
    if (!name || !secret) {
      throw new Error("Key name and secret key value are both required.");
    }
    // Step 1: Securely write target secret to local OS credentials manager vault
    await this.keytar.setPassword(this.serviceName, name, secret);
    return true;
  }

  async listKeys(): Promise<string[]> {
    // Retrieve all account entries linked under our application signature service tag
    const credentials = await this.keytar.findCredentials(this.serviceName);
    return credentials.map((cred: { account: string }) => cred.account);
  }
}

/**
 * CLI Command Router mimicking 'sorokeep keys add' actions
 */
export class KeysCliController {
  private store: KeychainStore;

  constructor(store: KeychainStore) {
    this.store = store;
  }

  // Simulates executing: sorokeep keys add --name <name>
  async handleAddKeyCommand(name: string, promptedSecret: string): Promise<string> {
    await this.store.saveKey(name, promptedSecret);
    return `Success: Keypair registered securely under label [${name}].`;
  }

  // Simulates execution that lists labels without leaking values
  async handleListKeysCommand(): Promise<string[]> {
    const labels = await this.store.listKeys();
    return labels; // Strictly returns names/labels; values stay safely hidden inside OS vault
  }
}

// ==========================================
// --- 2. TDD AUTOMATED TEST SUITE ---
// ==========================================

describe("TDD - Local OS Keychain & Safe CLI Key Management Engine", () => {
  let mockKeytar: any;
  let secureStore: SecureKeypairStore;
  let cliController: KeysCliController;
  
  // In-memory fake database tracking our OS keychain simulations cleanly
  let fakeKeychainDb: Array<{ account: string; value: string }>;

  beforeEach(() => {
    fakeKeychainDb = [];

    // Step 1: Build robust spy mocks matching native keytar interfaces
    mockKeytar = {
      setPassword: vi.fn().mockImplementation(async (service, account, password) => {
        fakeKeychainDb.push({ account, value: password });
        return null;
      }),
      findCredentials: vi.fn().mockImplementation(async (service) => {
        return fakeKeychainDb.map(item => ({ account: item.account, password: item.value }));
      })
    };

    secureStore = new SecureKeypairStore(mockKeytar);
    cliController = new KeysCliController(secureStore);
  });

  it("should successfully save a secret key into the native system credentials database", async () => {
    // Act
    const targetLabel = "deployer-keypair";
    const rawSecretSeed = "SCON3...SOROBAN...SECRET...SEED";
    
    const saveResult = await secureStore.saveKey(targetLabel, rawSecretSeed);

    // Assert: Verify internal keytar execution signals
    expect(saveResult).toBe(true);
    expect(mockKeytar.setPassword).toHaveBeenCalledTimes(1);
    expect(mockKeytar.setPassword).toHaveBeenCalledWith("sorokeep-keys", targetLabel, rawSecretSeed);
    
    // Confirm it exists in our simulated OS vault
    expect(fakeKeychainDb[0].value).toBe(rawSecretSeed);
  });

  it("should list registered key labels through CLI command without showing raw values", async () => {
    // Arrange: Populate keys inside the credential vault
    fakeKeychainDb.push({ account: "production-admin", value: "SECRET_AAA" });
    fakeKeychainDb.push({ account: "staging-validator", value: "SECRET_BBB" });

    // Act: Invoke listing operations
    const reportedLabels = await cliController.handleListKeysCommand();

    // Assert: Verify compliance with security criteria
    expect(reportedLabels).toContain("production-admin");
    expect(reportedLabels).toContain("staging-validator");
    expect(reportedLabels.length).toBe(2);

    // CRITICAL SECURITY ASSERTION: Make sure raw private secrets are completely hidden
    expect(reportedLabels).not.toContain("SECRET_AAA");
    expect(reportedLabels).not.toContain("SECRET_BBB");
  });

  it("should fail gracefully when attempting to save an empty key configuration parameters", async () => {
    // Act & Assert defensive tracking boundaries
    await expect(secureStore.saveKey("", "SCON123")).rejects.toThrow();
    await expect(secureStore.saveKey("valid-name", "")).rejects.toThrow();
    
    expect(mockKeytar.setPassword).not.toHaveBeenCalled();
  });
});