import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bcs } from '@mysten/sui/bcs';
import { GOVEX } from '../src/config.js';
import { buildClaimTransaction, calculateRedemption, formatAmount, loadRedemption, parseAmount, RedemptionPool, validateClaim, validatePool } from '../src/redemption.js';

const testAddress = `0x${'1'.repeat(64)}`;
function makePool(overrides = {}) {
  const fields = {
    id: GOVEX.poolId,
    dao_address: GOVEX.daoId,
    capability_id: GOVEX.capabilityId,
    total_asset_supply: '1000',
    remaining_asset_supply: '800',
    unlock_at_ms: '100',
    coin_type: { name: GOVEX.redeemCoinType.slice(2) },
    balance: '4000000',
    ...overrides,
  };
  return {
    objectId: GOVEX.poolId,
    type: `${GOVEX.originalActionsPackageId}::dissolution_actions::RedemptionPool<${GOVEX.redeemCoinType}>`,
    owner: { $kind: 'Shared' },
    content: RedemptionPool.serialize(fields).toBytes(),
  };
}
test('matches Move integer division without floating-point precision loss', () => {
  assert.equal(calculateRedemption(121_384_095_790n, 1_000_000_000_000n, 50_755_968_547_745_351n), 2_391_523n);
  assert.equal(calculateRedemption(10n, 1n, 3n), 3n);
  assert.equal(calculateRedemption(2n ** 64n - 1n, 2n ** 64n - 1n, 2n ** 64n - 1n), 2n ** 64n - 1n);
  assert.equal(calculateRedemption(0n, 10n, 100n), 0n);
  assert.equal(calculateRedemption(10n, 10n, 0n), 0n);
  assert.throws(() => calculateRedemption(10n, 11n, 10n));
});
test('parses exact decimal amounts and rejects ambiguous or over-precise input', () => {
  assert.equal(parseAmount('1000.000000001'), 1_000_000_000_001n);
  assert.equal(parseAmount(' 1. '), 1_000_000_000n);
  assert.equal(formatAmount(1_000_000_000_001n, 9), '1000.000000001');
  assert.equal(formatAmount(1n, 6), '0.000001');
  assert.equal(formatAmount(0n, 9), '0');
  for (const input of ['-1', '1e9', '1,000', '.5', 'NaN', '', '0.0000000001']) assert.throws(() => parseAmount(input));
});
test('rejects a pool for another DAO, capability, coin, object ID, or ownership', () => {
  assert.equal(validatePool(makePool()).remaining_asset_supply, '800');
  for (const fields of [{ dao_address: testAddress }, { capability_id: testAddress }, { id: testAddress }, { coin_type: { name: '2::sui::SUI' } }]) {
    assert.throws(() => validatePool(makePool(fields)), /identity/);
  }
  assert.throws(() => validatePool({ ...makePool(), type: '0x2::coin::Coin<0x2::sui::SUI>' }), /identity/);
  assert.throws(() => validatePool({ ...makePool(), objectId: testAddress }), /identity/);
  assert.throws(() => validatePool({ ...makePool(), owner: { $kind: 'AddressOwner' } }), /identity/);
});
test('uses live circulating supply after external burns and reads address balances', async () => {
  const Clock = bcs.struct('Clock', { id: bcs.Address, timestamp_ms: bcs.u64() });
  let liveSupply = 400n;
  const client = {
    getObject: async ({ objectId }) => ({ object: objectId === GOVEX.poolId ? makePool() : { content: Clock.serialize({ id: GOVEX.clockId, timestamp_ms: '200' }).toBytes() } }),
    stateService: { getCoinInfo: async () => ({ response: { treasury: { totalSupply: liveSupply } } }) },
    getBalance: async () => ({ balance: { balance: '100', coinBalance: '50', addressBalance: '50' } }),
  };
  const state = await loadRedemption(client, testAddress);
  assert.equal(state.walletBalance, 100n);
  assert.equal(state.supply, 400n);
  assert.equal(calculateRedemption(state.poolBalance, state.walletBalance, state.supply), 1_000_000n);
  validateClaim(state, 100n);
  assert.equal((await loadRedemption(client)).walletBalance, 0n);
  liveSupply = 801n;
  await assert.rejects(() => loadRedemption(client, testAddress), /out of sync/);
});
test('blocks locked, empty, too-small, or excessive claims', () => {
  const state = { chainTimeMs: 100, unlockAtMs: 100, walletBalance: 100n, poolBalance: 100n, supply: 1000n };
  validateClaim(state, 100n);
  assert.throws(() => validateClaim({ ...state, chainTimeMs: 99 }, 100n), /not open/);
  assert.throws(() => validateClaim(state, 0n), /greater than zero/);
  assert.throws(() => validateClaim(state, 101n), /exceeds/);
  assert.throws(() => validateClaim(state, 1n), /too small/);
  assert.throws(() => validateClaim({ ...state, poolBalance: 0n }, 100n), /too small/);
});
test('builds the deployed claim and transfers all returned USDC to the signer', () => {
  const tx = buildClaimTransaction(testAddress, 500n);
  const data = tx.getData();
  assert.equal(data.sender, testAddress);
  const intent = data.commands.find((command) => command.$kind === '$Intent');
  assert.equal(intent.$Intent.data.balance, 500n);
  assert.equal(intent.$Intent.data.type, GOVEX.assetType);
  const calls = data.commands.filter((command) => command.$kind === 'MoveCall');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].MoveCall.package, GOVEX.actionsPackageId);
  assert.equal(calls[0].MoveCall.module, 'dissolution_actions');
  assert.equal(calls[0].MoveCall.function, 'claim');
  assert.deepEqual(calls[0].MoveCall.typeArguments, [GOVEX.assetType, GOVEX.redeemCoinType]);
  assert.equal(calls[0].MoveCall.arguments.length, 5);
  const ids = data.inputs.filter((input) => input.$kind === 'UnresolvedObject').map((input) => input.UnresolvedObject.objectId);
  assert.deepEqual(ids, [GOVEX.poolId, GOVEX.daoId, GOVEX.packageRegistryId, `0x${'0'.repeat(63)}6`]);
  const transfer = data.commands.at(-1).TransferObjects;
  assert.equal(transfer.objects.length, 1);
  assert.equal(transfer.objects[0].Result, data.commands.findIndex((command) => command.$kind === 'MoveCall'));
  assert.equal(bcs.Address.parse(Buffer.from(data.inputs[transfer.address.Input].Pure.bytes, 'base64')), testAddress);
  assert.throws(() => buildClaimTransaction(testAddress, 0n));
});
