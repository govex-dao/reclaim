import { bcs } from '@mysten/sui/bcs';
import { coinWithBalance, Transaction } from '@mysten/sui/transactions';
import { normalizeStructTag, normalizeSuiAddress } from '@mysten/sui/utils';
import { GOVEX } from './config.js';
import { withTimeout } from './submission.js';

// Layout of the deployed Move structs. BCS avoids transport-specific JSON shapes.
export const RedemptionPool = bcs.struct('RedemptionPool', {
  id: bcs.Address,
  dao_address: bcs.Address,
  capability_id: bcs.Address,
  total_asset_supply: bcs.u64(),
  remaining_asset_supply: bcs.u64(),
  unlock_at_ms: bcs.u64(),
  coin_type: bcs.struct('TypeName', { name: bcs.string() }),
  balance: bcs.u64(),
});
const Clock = bcs.struct('Clock', { id: bcs.Address, timestamp_ms: bcs.u64() });

export function calculateRedemption(poolBalance, amount, supply) {
  if (poolBalance <= 0n || amount <= 0n || supply <= 0n) return 0n;
  if (amount > supply) throw new Error('Amount exceeds the remaining GOVEX supply.');
  return (poolBalance * amount) / supply;
}

export function parseAmount(text, decimals = GOVEX.assetDecimals) {
  const trimmed = text.trim();
  if (!/^\d+(\.\d*)?$/.test(trimmed)) throw new Error('Enter a valid GOVEX amount.');
  const [whole, fraction = ''] = trimmed.split('.');
  if (fraction.length > decimals) throw new Error(`Use at most ${decimals} decimal places.`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0'));
}

export function formatAmount(value, decimals, displayDecimals = decimals) {
  const scale = 10n ** BigInt(decimals);
  const whole = (value / scale).toString();
  const fraction = (value % scale).toString().padStart(decimals, '0')
    .slice(0, displayDecimals).replace(/0+$/, '');
  return whole + (fraction ? `.${fraction}` : '');
}

export function validatePool(object) {
  const expectedType = `${GOVEX.originalActionsPackageId}::dissolution_actions::RedemptionPool<${GOVEX.redeemCoinType}>`;
  if (object.objectId !== GOVEX.poolId || object.owner?.$kind !== 'Shared' ||
      normalizeStructTag(object.type) !== normalizeStructTag(expectedType)) {
    throw new Error('The Govex redemption pool identity does not match.');
  }
  const pool = RedemptionPool.parse(object.content);
  if (pool.id !== GOVEX.poolId || pool.dao_address !== GOVEX.daoId ||
      pool.capability_id !== GOVEX.capabilityId ||
      normalizeStructTag(pool.coin_type.name) !== normalizeStructTag(GOVEX.redeemCoinType)) {
    throw new Error('The Govex redemption pool identity does not match.');
  }
  return pool;
}

export async function loadRedemption(client, address) {
  const signal = AbortSignal.timeout(20_000);
  const [poolResponse, clockResponse, coinInfo, walletResponse] = await withTimeout(Promise.all([
    client.getObject({ objectId: GOVEX.poolId, include: { content: true }, signal }),
    client.getObject({ objectId: GOVEX.clockId, include: { content: true }, signal }),
    client.stateService.getCoinInfo({ coinType: GOVEX.assetType }, { abort: signal }),
    address ? client.getBalance({ owner: address, coinType: GOVEX.assetType, signal }) : null,
  ]));
  const pool = validatePool(poolResponse.object);
  const supply = coinInfo.response.treasury?.totalSupply;
  if (supply === undefined) throw new Error('The live GOVEX supply is unavailable.');
  if (supply > BigInt(pool.remaining_asset_supply)) {
    throw new Error('The pool and token supply are out of sync. Refresh and try again.');
  }
  const clock = Clock.parse(clockResponse.object.content);
  if (normalizeSuiAddress(clock.id) !== normalizeSuiAddress(GOVEX.clockId)) {
    throw new Error('The Sui clock identity does not match.');
  }
  return {
    address: address ?? null,
    poolBalance: BigInt(pool.balance),
    supply: BigInt(supply),
    walletBalance: BigInt(walletResponse?.balance.balance ?? '0'),
    unlockAtMs: Number(pool.unlock_at_ms),
    chainTimeMs: Number(clock.timestamp_ms),
    fetchedAt: Date.now(),
  };
}

export function validateClaim(state, amount) {
  if (state.chainTimeMs < state.unlockAtMs) throw new Error('Redemption is not open yet.');
  if (amount <= 0n) throw new Error('Enter an amount greater than zero.');
  if (amount > state.walletBalance) throw new Error('Amount exceeds your GOVEX balance.');
  if (calculateRedemption(state.poolBalance, amount, state.supply) <= 0n) {
    throw new Error('This amount is too small to receive USDC.');
  }
}

export function buildClaimTransaction(address, amount) {
  if (amount <= 0n) throw new Error('Enter an amount greater than zero.');
  const tx = new Transaction();
  tx.setSender(address);
  // Resolves and merges paginated coins, and supports Sui address balances.
  const assetCoin = coinWithBalance({ type: GOVEX.assetType, balance: amount });
  const usdc = tx.moveCall({
    target: `${GOVEX.actionsPackageId}::dissolution_actions::claim`,
    typeArguments: [GOVEX.assetType, GOVEX.redeemCoinType],
    arguments: [
      tx.object(GOVEX.poolId),
      tx.object(GOVEX.daoId),
      tx.object(GOVEX.packageRegistryId),
      assetCoin,
      tx.object(GOVEX.clockId),
    ],
  });
  tx.transferObjects([usdc], tx.pure.address(address));
  return tx;
}
