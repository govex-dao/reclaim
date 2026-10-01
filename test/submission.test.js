import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Transaction } from '@mysten/sui/transactions';
import { toBase64 } from '@mysten/sui/utils';
import { signClaim, submitSignedClaim, withTimeout } from '../src/submission.js';

const account = { address: `0x${'1'.repeat(64)}` };
async function preparedBytes(recipient = account.address) {
  // Fully resolved synthetic transaction; no wallet or RPC calls are needed.
  const tx = new Transaction();
  tx.setSender(account.address);
  tx.setGasOwner(account.address);
  tx.setGasPrice(1000);
  tx.setGasBudget(10_000_000);
  tx.setGasPayment([{ objectId: `0x${'3'.repeat(64)}`, version: '1', digest: '11111111111111111111111111111111' }]);
  tx.transferObjects([tx.gas], recipient);
  return tx.build();
}
async function signedClaim() {
  const bytes = await preparedBytes();
  return signClaim({
    bytes, account, getAccount: () => account,
    kit: { signTransaction: async () => ({ bytes: toBase64(bytes), signature: 'synthetic-signature' }) },
  });
}

test('signs on mainnet and knows the exact digest before broadcasting', async () => {
  const bytes = await preparedBytes();
  let called = false;
  const kit = { signTransaction: async (options) => {
    called = true;
    assert.equal(options.network, 'mainnet');
    assert.equal(options.account, account);
    assert.deepEqual(await options.transaction.build(), bytes);
    return { bytes: toBase64(bytes), signature: 'synthetic-signature' };
  } };
  const claim = await signClaim({ kit, bytes, account, getAccount: () => account });
  assert.equal(called, true);
  assert.equal(claim.address, account.address);
  assert.equal(claim.digest, await Transaction.from(bytes).getDigest());
  assert.equal(claim.bytes, toBase64(bytes));
});
test('wallet rejection returns before any submission can be recorded', async () => {
  const bytes = await preparedBytes();
  await assert.rejects(() => signClaim({
    bytes, account, getAccount: () => account,
    kit: { signTransaction: async () => { throw new Error('User rejected signing'); } },
  }), /rejected signing/);
});
test('rejects a changed payout transaction or missing signature', async () => {
  const bytes = await preparedBytes();
  const changedBytes = await preparedBytes(`0x${'2'.repeat(64)}`);
  await assert.rejects(() => signClaim({
    bytes, account, getAccount: () => account,
    kit: { signTransaction: async () => ({ bytes: toBase64(changedBytes), signature: 'synthetic-signature' }) },
  }), /changed the prepared transaction/);
  await assert.rejects(() => signClaim({
    bytes, account, getAccount: () => account,
    kit: { signTransaction: async () => ({ bytes: toBase64(bytes) }) },
  }), /signature/);
});
test('rejects wallet changes before and during the signing prompt', async () => {
  const bytes = await preparedBytes();
  let current = { address: `0x${'2'.repeat(64)}` };
  let signingCalls = 0;
  const kit = { signTransaction: async () => {
    signingCalls++;
    current = null;
    return { bytes: toBase64(bytes), signature: 'synthetic-signature' };
  } };
  await assert.rejects(() => signClaim({ kit, bytes, account, getAccount: () => current }), /wallet changed/);
  assert.equal(signingCalls, 0);
  current = account;
  await assert.rejects(() => signClaim({ kit, bytes, account, getAccount: () => current }), /wallet changed/);
  assert.equal(signingCalls, 1);
});
test('a lost response can be retried with identical bytes, signature, and digest', async () => {
  const claim = await signedClaim();
  const calls = [];
  const client = { executeTransaction: (input) => {
    calls.push(input);
    if (calls.length === 1) return new Promise(() => {});
    return Promise.resolve({ Transaction: { digest: claim.digest, status: { success: true } } });
  } };
  await assert.rejects(() => submitSignedClaim(client, claim, 5), /too long/);
  assert.equal((await submitSignedClaim(client, claim)).Transaction.digest, claim.digest);
  assert.deepEqual(calls[0], calls[1]);
  assert.deepEqual(calls[0].signatures, ['synthetic-signature']);
  assert.equal(await Transaction.from(calls[1].transaction).getDigest(), claim.digest);
});
test('keeps unknown or mismatched node responses distinct from a confirmed failure', async () => {
  const claim = await signedClaim();
  await assert.rejects(() => submitSignedClaim({ executeTransaction: async () => ({}) }, claim), /did not confirm/);
  await assert.rejects(() => submitSignedClaim({ executeTransaction: async () => ({ Transaction: { digest: 'different' } }) }, claim), /did not confirm/);
  const failure = { FailedTransaction: { digest: claim.digest, status: { success: false, error: { message: 'Move abort' } } } };
  assert.equal(await submitSignedClaim({ executeTransaction: async () => failure }, claim), failure);
});
test('bounds node waits and propagates confirmed errors', async () => {
  assert.equal(await withTimeout(Promise.resolve('ready'), 10), 'ready');
  await assert.rejects(() => withTimeout(Promise.reject(new Error('offline')), 10), /offline/);
  await assert.rejects(() => withTimeout(new Promise(() => {}), 5), /too long/);
});
