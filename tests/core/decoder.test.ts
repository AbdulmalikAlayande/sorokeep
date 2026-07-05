import { describe, it, expect } from 'vitest';
import { decodeLedgerKey } from '../../src/core/decoder.js';
import { xdr, Address } from '@stellar/stellar-sdk';

describe('Ledger Key Decoder', () => {
  it('decodes instance key successfully', () => {
    // contract instance
    const contractId = 'CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6';
    const contractAddress = Address.fromString(contractId);

    const key = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
      contract: contractAddress.toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent()
    }));

    const base64Key = key.toXDR('base64');
    const result = decodeLedgerKey(base64Key);

    expect(result).toMatchObject({
      contractId,
      symbol: 'ContractInstance',
      durability: 'Persistent'
    });
  });

  it('decodes data storage key successfully', () => {
    const contractId = 'CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6';
    const contractAddress = Address.fromString(contractId);

    const key = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
      contract: contractAddress.toScAddress(),
      key: xdr.ScVal.scvSymbol('Admin'),
      durability: xdr.ContractDataDurability.temporary()
    }));

    const base64Key = key.toXDR('base64');
    const result = decodeLedgerKey(base64Key);

    expect(result).toMatchObject({
      contractId,
      symbol: 'Admin',
      durability: 'Temporary'
    });
  });
});
