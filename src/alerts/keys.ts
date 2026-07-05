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
