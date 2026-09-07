#![no_std]

use soroban_sdk::{contract, contractimpl, Address, Env};
use stellar_access::ownable::Ownable;

#[contract]
pub struct StarterContract;

#[contractimpl]
impl StarterContract {
    pub fn init(env: Env, owner: Address) {
        Ownable::init_owner(&env, &owner);
    }

    pub fn transfer_ownership(env: Env, new_owner: Address) {
        Ownable::check_owner(&env);
        Ownable::set_owner(&env, &new_owner);
    }
}

mod test;
