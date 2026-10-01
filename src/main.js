import { createDAppKit } from '@mysten/dapp-kit-core';
import '@mysten/dapp-kit-core/web';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { GOVEX } from './config.js';
import { buildClaimTransaction, calculateRedemption, formatAmount, loadRedemption, parseAmount, validateClaim } from './redemption.js';
import { signClaim, submitSignedClaim, withTimeout } from './submission.js';
import './style.css';

const client = new SuiGrpcClient({ network: GOVEX.network, baseUrl: GOVEX.grpcUrl });
const kit = createDAppKit({
  networks: [GOVEX.network],
  defaultNetwork: GOVEX.network,
  createClient: () => client,
  slushWalletConfig: null,
  storageKey: 'govex-reclaim:wallet',
});
document.querySelector('mysten-dapp-kit-connect-button').instance = kit;
const byId = (id) => document.getElementById(id);
const amountInput = byId('amount');
let state = null;
let loading = false;
let loadError = '';
let busy = false;
let phase = '';
let requestId = 0;
let lastAddress;
let useMax = true;
const pendingStorageKey = 'govex-reclaim:pending';
let pendingClaim = null;
try {
  const saved = JSON.parse(sessionStorage.getItem(pendingStorageKey));
  if (saved && ['address', 'digest', 'bytes', 'signature'].every((key) => typeof saved[key] === 'string')) pendingClaim = saved;
} catch { /* Session storage may be unavailable; in-memory tracking still works. */ }

function setPendingClaim(claim) {
  pendingClaim = claim;
  try {
    if (claim) sessionStorage.setItem(pendingStorageKey, JSON.stringify(claim));
    else sessionStorage.removeItem(pendingStorageKey);
  } catch { /* Keep the pending claim in memory if browser storage is disabled. */ }
}
function showReceipt(digest) {
  byId('receipt').href = `https://suiscan.xyz/mainnet/tx/${encodeURIComponent(digest)}`;
  byId('receipt').hidden = false;
}

function currentAccount() { return kit.stores.$connection.get().account; }
function showMessage(text, error = false) {
  byId('message').textContent = text;
  byId('message').hidden = !text;
  byId('message').classList.toggle('error', error);
}
function render() {
  const account = currentAccount();
  const matchingState = state && state.address === (account?.address ?? null);
  const usable = matchingState && !loadError && Date.now() - state.fetchedAt < 45_000;
  const open = matchingState && state.chainTimeMs >= state.unlockAtMs;
  const unlockedAt = matchingState ? new Date(state.unlockAtMs).toLocaleString() : '';
  byId('pool-status').textContent = loadError ? 'Pool unavailable' : !matchingState ? 'Loading pool…' : open ? 'Redemption open' : `Opens ${unlockedAt}`;
  byId('balance').textContent = !account ? 'Connect your wallet to see your balance.' : !matchingState ? 'Loading your GOVEX balance…' : `Available: ${formatAmount(state.walletBalance, GOVEX.assetDecimals)} GOVEX`;
  byId('pool-balance').textContent = matchingState ? `${formatAmount(state.poolBalance, GOVEX.redeemCoinDecimals)} USDC` : '—';
  byId('rate').textContent = matchingState && state.supply > 0n ? formatAmount((state.poolBalance * 10n ** BigInt(GOVEX.assetDecimals)) / state.supply, GOVEX.redeemCoinDecimals) : '—';
  byId('updated').textContent = loadError ? 'Could not refresh. Try again using ↻.' : matchingState ? `Last updated ${new Date(state.fetchedAt).toLocaleTimeString()}` : 'Reading directly from Sui…';
  byId('refresh').disabled = loading || busy;
  amountInput.disabled = !account || !usable || busy;
  byId('max').disabled = amountInput.disabled;

  let amount = 0n;
  let amountError = '';
  if (account && usable && amountInput.value) {
    try { amount = parseAmount(amountInput.value); validateClaim(state, amount); }
    catch (error) { amountError = error.message; }
  }
  byId('amount-error').textContent = amountError;
  byId('amount-error').hidden = !amountError;
  amountInput.setAttribute('aria-invalid', String(!!amountError));
  byId('estimate').textContent = usable && amount > 0n && !amountError ? formatAmount(calculateRedemption(state.poolBalance, amount, state.supply), GOVEX.redeemCoinDecimals) : '—';
  const canRedeem = account && usable && open && amount > 0n && !amountError && !busy && !pendingClaim;
  byId('redeem').disabled = !canRedeem;
  const label = busy ? phase : pendingClaim ? 'Waiting for transaction confirmation…' : !account ? 'Connect wallet to redeem' : !usable ? 'Waiting for live balances…' : !open ? 'Redemption not open yet' : state.walletBalance === 0n ? 'No GOVEX to redeem' : 'Redeem GOVEX for USDC';
  byId('redeem').replaceChildren(document.createTextNode(label));
  if (canRedeem) { const arrow = document.createElement('span'); arrow.textContent = '↗'; arrow.setAttribute('aria-hidden', 'true'); byId('redeem').append(arrow); }
  byId('retry').hidden = !pendingClaim;
  byId('retry').disabled = busy || !account || account.address !== pendingClaim?.address;
  byId('retry-note').hidden = !pendingClaim;
}

async function refresh() {
  if (busy || loading) return;
  const thisRequest = ++requestId;
  const address = currentAccount()?.address ?? null;
  const previousLoadError = loadError;
  let poolLoaded = false;
  loading = true;
  render();
  try {
    let fresh = await loadRedemption(client, address);
    if (thisRequest !== requestId || address !== (currentAccount()?.address ?? null)) return;
    poolLoaded = true;
    if (pendingClaim) {
      state = fresh;
      loadError = '';
      if (address && useMax) amountInput.value = formatAmount(state.walletBalance, GOVEX.assetDecimals);
      render();
      // Keep claims disabled until the fullnode has observed the submitted claim.
      const pending = pendingClaim;
      const result = await withTimeout(client.waitForTransaction({ digest: pending.digest, timeout: 15_000 }), 16_000);
      fresh = await loadRedemption(client, address);
      if (thisRequest !== requestId || address !== (currentAccount()?.address ?? null)) return;
      const transaction = result.Transaction ?? result.FailedTransaction;
      if (!transaction || transaction.digest !== pending.digest) throw new Error('The node has not confirmed this transaction yet.');
      setPendingClaim(null);
      showMessage(result.FailedTransaction ? result.FailedTransaction.status.error?.message ?? 'The transaction failed. Your GOVEX was not redeemed.' : 'GOVEX redeemed. Your USDC was sent to the wallet that signed the transaction.', !!result.FailedTransaction);
      useMax = true;
    }
    state = fresh;
    loadError = '';
    if (address && useMax) amountInput.value = formatAmount(state.walletBalance, GOVEX.assetDecimals);
    if (previousLoadError && byId('message').textContent === previousLoadError) showMessage('');
  } catch (error) {
    if (thisRequest !== requestId) return;
    const detail = error instanceof Error ? error.message : 'Could not load the redemption pool.';
    if (!poolLoaded || !pendingClaim) loadError = detail;
    showMessage(pendingClaim ? 'The transaction outcome is not confirmed yet. Further claims are paused. Check the transaction link, or retry the same signed transaction using the original wallet.' : loadError, !pendingClaim);
  } finally {
    if (thisRequest === requestId) { loading = false; render(); }
  }
}

kit.stores.$connection.subscribe((connection) => {
  const address = connection.account?.address ?? null;
  if (address === lastAddress) return;
  lastAddress = address;
  ++requestId;
  loading = false;
  state = null;
  loadError = '';
  useMax = true;
  amountInput.value = '';
  if (!busy && !pendingClaim) { showMessage(''); byId('receipt').hidden = true; }
  render();
  void refresh();
});
amountInput.addEventListener('input', () => { useMax = false; render(); });
byId('max').addEventListener('click', () => {
  if (!state || busy) return;
  useMax = true;
  amountInput.value = formatAmount(state.walletBalance, GOVEX.assetDecimals);
  render();
});
byId('refresh').addEventListener('click', () => { void refresh(); });
async function broadcastPendingClaim() {
  phase = 'Submitting redemption…';
  render();
  const result = await submitSignedClaim(client, pendingClaim);
  if (result.FailedTransaction) {
    setPendingClaim(null);
    throw new Error(result.FailedTransaction.status.error?.message ?? 'The transaction failed. Your GOVEX was not redeemed.');
  }
  showMessage('GOVEX redeemed. Your USDC was sent to the wallet that signed the transaction.');
}
function showClaimError(error) {
  const detail = error instanceof Error ? error.message : 'Redemption failed.';
  showMessage(pendingClaim ? 'The transaction outcome is not confirmed yet. Further claims are paused. Check the transaction link, or retry the same signed transaction using the original wallet.' : detail, !pendingClaim);
}
byId('retry').addEventListener('click', async () => {
  if (!pendingClaim || busy || currentAccount()?.address !== pendingClaim.address) return;
  busy = true;
  ++requestId;
  loading = false;
  try { await broadcastPendingClaim(); }
  catch (error) { showClaimError(error); }
  finally { busy = false; phase = ''; render(); void refresh(); }
});
byId('claim-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const account = currentAccount();
  if (!account || busy || byId('redeem').disabled) return;
  const address = account.address;
  const redeemMax = useMax;
  const requestedText = amountInput.value;
  busy = true;
  ++requestId;
  loading = false;
  phase = 'Checking your redemption…';
  showMessage('');
  byId('receipt').hidden = true;
  render();
  try {
    const requestedAmount = parseAmount(requestedText);
    const fresh = await loadRedemption(client, address);
    const amount = redeemMax ? fresh.walletBalance : requestedAmount;
    validateClaim(fresh, amount);
    if (currentAccount()?.address !== address) throw new Error('Your wallet changed. Try again with the current wallet.');
    state = fresh;
    amountInput.value = formatAmount(amount, GOVEX.assetDecimals);
    const tx = buildClaimTransaction(address, amount);
    const bytes = await withTimeout(tx.build({ client }));
    const simulation = await withTimeout(client.simulateTransaction({ transaction: bytes, signal: AbortSignal.timeout(20_000) }));
    if (simulation.FailedTransaction) throw new Error(simulation.FailedTransaction.status.error?.message ?? 'The redemption transaction could not be completed.');
    if (currentAccount()?.address !== address) throw new Error('Your wallet changed. Try again with the current wallet.');
    phase = 'Confirm in your wallet…';
    render();
    const signed = await signClaim({ kit, bytes, account, getAccount: currentAccount });
    setPendingClaim(signed);
    showReceipt(signed.digest);
    await broadcastPendingClaim();
  } catch (error) {
    showClaimError(error);
  } finally {
    busy = false;
    phase = '';
    render();
    void refresh();
  }
});

if (pendingClaim) {
  showReceipt(pendingClaim.digest);
  showMessage('Resuming confirmation of your previous redemption. Further claims are paused until its outcome is confirmed.');
}

for (const [label, value, type] of [
  ['Govex DAO', GOVEX.daoId, 'object'],
  ['USDC redemption pool', GOVEX.poolId, 'object'],
  ['Claim package', GOVEX.actionsPackageId, 'object'],
  ['Package registry', GOVEX.packageRegistryId, 'object'],
  ['GOVEX coin type', GOVEX.assetType, 'coin'],
  ['USDC coin type', GOVEX.redeemCoinType, 'coin'],
]) {
  const term = document.createElement('dt'); term.textContent = label;
  const definition = document.createElement('dd');
  const link = document.createElement('a'); link.textContent = value;
  link.href = `https://suiscan.xyz/mainnet/${type}/${encodeURIComponent(value)}`;
  link.target = '_blank'; link.rel = 'noopener noreferrer';
  definition.append(link); byId('contracts').append(term, definition);
}
setInterval(() => { if (!document.hidden) void refresh(); }, 30_000);
setInterval(render, 5_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
