import { Transaction } from '@mysten/sui/transactions';
import { fromBase64 } from '@mysten/sui/utils';
import { GOVEX } from './config.js';

// Some SDK transports do not forward AbortSignal. Bound how long the UI waits
// while keeping an unknown submission pending until its outcome is confirmed.
export async function withTimeout(promise, timeoutMs = 20_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('The Sui node took too long to respond. Try again.')), timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

export async function signClaim({ kit, bytes, account, getAccount }) {
  const assertAccount = () => {
    if (getAccount()?.address !== account.address) throw new Error('Your wallet changed. Try again with the current wallet.');
  };
  assertAccount();
  const prepared = Transaction.from(bytes);
  const digest = await prepared.getDigest();
  const signed = await kit.signTransaction({ transaction: prepared, account, network: GOVEX.network });
  assertAccount();
  const signedDigest = await Transaction.from(signed.bytes).getDigest();
  if (signedDigest !== digest) throw new Error('The wallet changed the prepared transaction. Nothing was submitted.');
  if (!signed.signature) throw new Error('The wallet did not return a transaction signature.');
  return { address: account.address, digest, bytes: signed.bytes, signature: signed.signature };
}

export async function submitSignedClaim(client, claim, timeoutMs = 20_000) {
  const result = await withTimeout(client.executeTransaction({
    transaction: fromBase64(claim.bytes),
    signatures: [claim.signature],
  }), timeoutMs);
  const transaction = result.Transaction ?? result.FailedTransaction;
  if (!transaction || transaction.digest !== claim.digest) {
    throw new Error('The node did not confirm the submitted transaction.');
  }
  return result;
}
