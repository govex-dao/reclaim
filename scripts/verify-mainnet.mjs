import assert from 'node:assert/strict';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { normalizeStructTag } from '@mysten/sui/utils';
import { GOVEX } from '../src/config.js';
import { calculateRedemption, formatAmount, loadRedemption } from '../src/redemption.js';

// Read-only verification. Never connects a wallet, signs, or submits a transaction.
const client = new SuiGrpcClient({ network: GOVEX.network, baseUrl: GOVEX.grpcUrl });
const signal = AbortSignal.timeout(20_000);
const [state, registry, dao, claim, asset, stable] = await Promise.all([
  loadRedemption(client),
  client.getObject({ objectId: GOVEX.packageRegistryId, signal }),
  client.getObject({ objectId: GOVEX.daoId, signal }),
  client.core.getMoveFunction({ packageId: GOVEX.actionsPackageId, moduleName: 'dissolution_actions', name: 'claim', signal }),
  client.getCoinMetadata({ coinType: GOVEX.assetType, signal }),
  client.getCoinMetadata({ coinType: GOVEX.redeemCoinType, signal }),
]);
assert.equal(registry.object.type, `${GOVEX.accountPackageId}::package_registry::PackageRegistry`);
assert.equal(registry.object.owner.$kind, 'Shared');
assert.equal(dao.object.type, `${GOVEX.accountPackageId}::account::Account`);
assert.equal(dao.object.owner.$kind, 'Shared');
assert.equal(asset.coinMetadata?.decimals, GOVEX.assetDecimals);
assert.equal(stable.coinMetadata?.decimals, GOVEX.redeemCoinDecimals);
assert.equal(claim.function.visibility, 'public');
assert.equal(claim.function.typeParameters.length, 2);
assert.equal(claim.function.parameters.length, 6);
assert.equal(claim.function.returns.length, 1);
const expectedParameters = [
  ['mutable', `${GOVEX.originalActionsPackageId}::dissolution_actions::RedemptionPool`],
  ['mutable', `${GOVEX.accountPackageId}::account::Account`],
  ['immutable', `${GOVEX.accountPackageId}::package_registry::PackageRegistry`],
  [null, '0x2::coin::Coin'],
  ['immutable', '0x2::clock::Clock'],
  ['mutable', '0x2::tx_context::TxContext'],
];
for (const [index, [reference, typeName]] of expectedParameters.entries()) {
  const parameter = claim.function.parameters[index];
  assert.equal(parameter.reference, reference);
  assert.equal(normalizeStructTag(parameter.body.datatype.typeName), normalizeStructTag(typeName));
}
assert.equal(claim.function.parameters[0].body.datatype.typeParameters[0].index, 1);
assert.equal(claim.function.parameters[3].body.datatype.typeParameters[0].index, 0);
assert.equal(normalizeStructTag(claim.function.returns[0].body.datatype.typeName), normalizeStructTag('0x2::coin::Coin'));
assert.equal(claim.function.returns[0].body.datatype.typeParameters[0].index, 1);
console.log('Verified mainnet pool identity, DAO, registry, token decimals, supply, clock, and deployed claim signature.');
console.log(`Pool balance: ${formatAmount(state.poolBalance, GOVEX.redeemCoinDecimals)} USDC`);
console.log(`GOVEX supply: ${formatAmount(state.supply, GOVEX.assetDecimals)}`);
console.log(`Redemption: ${state.chainTimeMs >= state.unlockAtMs ? 'open' : 'time-locked'}`);
if (state.supply >= 1000n * 10n ** 9n) {
  console.log(`1,000 GOVEX estimate: ${formatAmount(calculateRedemption(state.poolBalance, 1000n * 10n ** 9n, state.supply), GOVEX.redeemCoinDecimals)} USDC`);
}
