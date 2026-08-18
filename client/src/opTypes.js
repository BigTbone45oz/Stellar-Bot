// Horizon's operation `type` field is a snake_case API identifier, not a display
// name. Maps each operation type to a proper label/description, per Stellar's docs
// (developers.stellar.org/docs/learn/fundamentals/transactions/list-of-operations),
// plus `inflation` (disabled since 2019 but still a valid historical type) and
// `restore_footprint` (Soroban state archival), neither covered by that page.
export const OPERATION_TYPES = {
  create_account: {
    label: 'Create Account',
    description: 'Creates and funds a new account with a starting XLM balance.',
  },
  payment: {
    label: 'Payment',
    description: 'Sends a payment of a specified asset to a destination account.',
  },
  path_payment_strict_send: {
    label: 'Path Payment (Strict Send)',
    description:
      'Sends a fixed amount of one asset and converts it through the DEX, so the recipient gets a different asset.',
  },
  path_payment_strict_receive: {
    label: 'Path Payment (Strict Receive)',
    description:
      'Sends one asset and converts it through the DEX so the recipient receives a fixed amount of a different asset.',
  },
  manage_sell_offer: {
    label: 'Manage Sell Offer',
    description: 'Creates, updates, or deletes an offer on the DEX to sell one asset for another.',
  },
  manage_buy_offer: {
    label: 'Manage Buy Offer',
    description: 'Creates, updates, or deletes an offer on the DEX to buy one asset with another.',
  },
  create_passive_sell_offer: {
    label: 'Create Passive Sell Offer',
    description: "Creates a sell offer that won't immediately match an existing offer at the same price.",
  },
  set_options: {
    label: 'Set Options',
    description: "Changes an account's settings — signers, thresholds, home domain, or flags.",
  },
  change_trust: {
    label: 'Change Trust',
    description: 'Creates, updates, or removes a trustline, allowing an account to hold a given asset.',
  },
  allow_trust: {
    label: 'Allow Trust',
    description:
      "Authorizes or deauthorizes another account's trustline to an asset (superseded by Set Trustline Flags).",
  },
  account_merge: {
    label: 'Account Merge',
    description: "Transfers an account's remaining XLM balance to another account and deletes the source account.",
  },
  inflation: {
    label: 'Inflation',
    description: 'Ran the network-wide inflation payout — the feature has been disabled since 2019.',
  },
  manage_data: {
    label: 'Manage Data',
    description: 'Sets, updates, or deletes a custom name/value data entry attached to an account.',
  },
  bump_sequence: {
    label: 'Bump Sequence',
    description: "Forces an account's sequence number forward, invalidating any pending transaction below it.",
  },
  create_claimable_balance: {
    label: 'Create Claimable Balance',
    description: 'Sets aside an asset amount for one or more future claimants to claim later.',
  },
  claim_claimable_balance: {
    label: 'Claim Claimable Balance',
    description: 'Claims a previously created claimable balance, adding its funds to the claiming account.',
  },
  begin_sponsoring_future_reserves: {
    label: 'Begin Sponsoring Future Reserves',
    description: "Starts paying another account's minimum-balance reserve requirements on its behalf.",
  },
  end_sponsoring_future_reserves: {
    label: 'End Sponsoring Future Reserves',
    description: 'Ends a reserve-sponsorship relationship for the source account.',
  },
  revoke_sponsorship: {
    label: 'Revoke Sponsorship',
    description: 'Removes or transfers an existing reserve sponsorship of a ledger entry or signer.',
  },
  clawback: {
    label: 'Clawback',
    description: "Burns (reclaims) a held amount of an asset from another account — issuer-only.",
  },
  clawback_claimable_balance: {
    label: 'Clawback Claimable Balance',
    description: 'Burns the pending amount in an unclaimed claimable balance — issuer-only.',
  },
  set_trust_line_flags: {
    label: 'Set Trustline Flags',
    description: "Lets an asset's issuer configure authorization/clawback flags on a specific trustline.",
  },
  liquidity_pool_deposit: {
    label: 'Liquidity Pool Deposit',
    description: 'Deposits a pair of assets into a liquidity pool in exchange for pool shares.',
  },
  liquidity_pool_withdraw: {
    label: 'Liquidity Pool Withdraw',
    description: 'Redeems pool shares for a share of the underlying liquidity pool reserves.',
  },
  invoke_host_function: {
    label: 'Invoke Host Function',
    description: 'Runs a Soroban smart contract call, WASM upload, or contract deployment.',
  },
  extend_footprint_ttl: {
    label: 'Extend Footprint TTL',
    description: "Extends how long a Soroban contract's ledger data is retained before archival.",
  },
  restore_footprint: {
    label: 'Restore Footprint',
    description: 'Restores archived Soroban contract ledger data so it can be accessed again.',
  },
};

// Fallback for any future operation type Horizon adds before this map is updated —
// title-cases the raw identifier instead of showing it blank or throwing.
function titleCase(type) {
  return type.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

export function operationTypeLabel(type) {
  return OPERATION_TYPES[type]?.label || titleCase(type);
}

export function operationTypeDescription(type) {
  return OPERATION_TYPES[type]?.description || 'No description available for this operation type yet.';
}

// A single Horizon operation `type` ("invoke_host_function") covers three
// meaningfully different actions, distinguished by the op's own `function` field:
// invoke/create/upload-wasm (see @stellar/stellar-sdk's xdr.HostFunctionType enum).
export const HOST_FUNCTION_TYPES = {
  HostFunctionTypeHostFunctionTypeInvokeContract: {
    label: 'Invoke Contract',
    description: 'Calls a function on an already-deployed Soroban smart contract.',
  },
  HostFunctionTypeHostFunctionTypeCreateContract: {
    label: 'Create Contract',
    description: 'Deploys a new Soroban smart contract instance to the ledger.',
  },
  HostFunctionTypeHostFunctionTypeUploadContractWasm: {
    label: 'Upload Contract Wasm',
    description: "Uploads a contract's compiled WASM bytecode to the ledger, without deploying an instance.",
  },
};

export function hostFunctionLabel(fn) {
  return HOST_FUNCTION_TYPES[fn]?.label || titleCase(fn.replace(/^HostFunctionTypeHostFunctionType/, ''));
}

export function hostFunctionDescription(fn) {
  return HOST_FUNCTION_TYPES[fn]?.description || 'No description available for this function type yet.';
}
