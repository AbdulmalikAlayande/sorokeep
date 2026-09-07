#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, Address, Env};

#[test]
fn test_contract() {
    let env = Env::default();
    let contract_id = env.register_contract(None, StarterContract);
    let client = StarterContractClient::new(&env, &contract_id);

    let owner = Address::generate(&env);
    client.init(&owner);

    // Verify it doesn't crash on init
    // (OpenZeppelin tests would check ownership here)
}
