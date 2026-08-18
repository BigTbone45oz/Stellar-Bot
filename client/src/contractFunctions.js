// A contract's invoked function name is chosen by whoever wrote that contract, not
// fixed by protocol — "transfer" probably means the standard thing, but isn't
// guaranteed. Split into confidence tiers so the UI can reflect that.

// SEP-41 (developers.stellar.org/docs/tokens/token-interface) — the documented
// standard interface every fungible Soroban token contract is expected to implement.
const SEP41_FUNCTIONS = {
  allowance: "Returns how much a spender is approved to transfer on another account's behalf.",
  approve: 'Grants a spender permission to transfer up to a set amount of tokens.',
  balance: "Returns an account's token balance.",
  transfer: 'Moves tokens directly from the caller to another account.',
  transfer_from: 'Moves tokens on behalf of another account, up to a previously approved amount.',
  burn: 'Permanently destroys tokens from an account, reducing total supply.',
  burn_from: 'Destroys tokens from another account, up to a previously approved amount.',
  decimals: 'Returns how many decimal places the token uses.',
  name: "Returns the token's display name.",
  symbol: "Returns the token's ticker symbol.",
};

// Common naming conventions seen across Soroban DeFi/token contracts — not a formal
// standard like SEP-41, just names that keep showing up. Educated guess, not a guarantee.
const CONVENTIONAL_FUNCTIONS = {
  mint: 'Likely creates new tokens and credits them to an account (common in token/NFT contracts).',
  swap: 'Likely exchanges one asset for another, typically through an AMM or DEX contract.',
  deposit: 'Likely adds funds into a pool, vault, or lending contract.',
  withdraw: 'Likely removes funds from a pool, vault, or lending contract.',
  stake: 'Likely locks tokens into a contract, typically to earn rewards or gain voting power.',
  unstake: 'Likely unlocks previously staked tokens.',
  claim: 'Likely collects accumulated rewards or a previously allocated balance.',
  initialize: 'Likely a one-time setup call that configures a newly deployed contract instance.',
};

// Horizon's `asset_balance_changes[].type` on invoke_host_function ops — fixed by
// protocol (CAP-67), so these four are exhaustive and guaranteed, unlike function names above.
const MOVEMENT_TYPES = {
  transfer: 'The asset moved between two accounts — no supply change. The clearest signal of actual trading/payment activity.',
  mint: 'New units of the asset were created and credited to an account — total supply increased.',
  burn: 'Units of the asset were destroyed by the holder — total supply decreased.',
  clawback: "The asset's issuer forcibly reclaimed and destroyed units from an account.",
};

export function movementTypeDescription(type) {
  return MOVEMENT_TYPES[type] || 'Unrecognized asset movement type.';
}

export function contractFunctionInfo(name) {
  if (SEP41_FUNCTIONS[name]) {
    return { description: SEP41_FUNCTIONS[name], confidence: 'standard' };
  }
  if (CONVENTIONAL_FUNCTIONS[name]) {
    return { description: CONVENTIONAL_FUNCTIONS[name], confidence: 'convention' };
  }
  return {
    description:
      "Custom function defined by whichever contract(s) called it — the name is a hint, not a guarantee, since it isn't defined by any Stellar protocol standard.",
    confidence: 'unknown',
  };
}
