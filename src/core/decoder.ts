import { xdr, Address, scValToNative } from '@stellar/stellar-sdk';

export interface DecodedLedgerKey {
  contractId: string;
  symbol: any;
  durability: string;
}

export function decodeLedgerKey(base64Key: string): DecodedLedgerKey {
  const buf = Buffer.from(base64Key, 'base64');
  const key = xdr.LedgerKey.fromXDR(buf);
  
  if (key.switch() !== xdr.LedgerEntryType.contractData()) {
    throw new Error('Unsupported ledger entry type');
  }

  const contractData = key.contractData();
  const contractAddress = Address.fromScAddress(contractData.contract());
  const contractId = contractAddress.toString();

  const scValKey = contractData.key();
  let symbol: any;
  if (scValKey.switch() === xdr.ScValType.scvLedgerKeyContractInstance()) {
    symbol = 'ContractInstance';
  } else {
    try {
      symbol = scValToNative(scValKey);
    } catch {
      symbol = 'Unknown';
    }
  }

  const durabilityType = contractData.durability();
  let durability = 'Unknown';
  if (durabilityType.value === xdr.ContractDataDurability.persistent().value) {
    durability = 'Persistent';
  } else if (durabilityType.value === xdr.ContractDataDurability.temporary().value) {
    durability = 'Temporary';
  }

  return {
    contractId,
    symbol,
    durability
  };
}
