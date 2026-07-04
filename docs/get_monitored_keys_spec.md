# Contract Introspection Standard: `get_monitored_keys`

## Context & Objective

In the Soroban smart contract ecosystem, developers need a standard way to declare which storage keys their contracts monitor or rely upon. Similar to ERC or SEP metadata conventions, exposing a predictable interface allows external tools, indexers, and monitoring daemons (like Sorokeep) to automatically discover and track these critical state entries without requiring manual configuration or deep knowledge of the contract's internal logic.

This specification outlines the standard contract introspection function `get_monitored_keys()` which returns a vector of storage keys.

## Specification

A conforming smart contract MUST implement the following view function:

### Function Signature

```rust
pub fn get_monitored_keys(env: Env) -> Vec<ScVal>
```

- **Parameters:**
  - `env`: The Soroban `Env` object.
- **Returns:**
  - A `Vec<ScVal>` where each `ScVal` is a valid storage key used by the contract (e.g., `Symbol`, `Address`, or a custom composite key).

### Behavior

- The function MUST NOT modify the contract state (it should be treated as a view function).
- The function SHOULD return all persistent or instance storage keys that are critical to the contract's operation and should be monitored for TTL/rent extensions.
- If the contract dynamically generates keys, it SHOULD return the base keys or prefixes if possible, though exact discrete keys are preferred for direct TTL monitoring.

## Example Implementation

Below is a valid Rust Soroban contract code snippet demonstrating how to implement this standard.

```rust
#![no_std]
use soroban_sdk::{contract, contractimpl, Env, Symbol, Vec, symbol_short, Address};

#[contract]
pub struct MonitoredContract;

#[contractimpl]
impl MonitoredContract {
    /// Returns the list of storage keys monitored by this contract.
    pub fn get_monitored_keys(env: Env) -> Vec<soroban_sdk::Val> {
        let mut keys = Vec::new(&env);
        
        // Example: Monitor a simple symbol key
        keys.push_back(symbol_short!("ADMIN").into_val(&env));
        
        // Example: Monitor a known specific address key or other metadata
        keys.push_back(symbol_short!("STATE").into_val(&env));
        
        keys
    }

    /// Example state modification function
    pub fn set_admin(env: Env, admin: Address) {
        env.storage().instance().set(&symbol_short!("ADMIN"), &admin);
    }
}
```

## Security & Privacy Considerations

- Exposing storage keys via `get_monitored_keys` does not expose the *values* stored at those keys. However, developers should be aware that revealing the keys makes it easier for third parties to observe changes to those specific storage slots on the ledger.
- This function is meant purely for introspection and TTL monitoring. It does not replace proper authorization checks (`admin.require_auth()`) for any state-modifying functions.
