import { createDAppKit } from '@mysten/dapp-kit-core';
import '@mysten/dapp-kit-core/web';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { GOVEX } from './config.js';
import { buildClaimTransaction, calculateRedemption, formatAmount, loadRedemption, parseAmount, validateClaim } from './redemption.js';
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
let submittedDigest = null;

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
  const canRedeem = account && usable && open && amount > 0n && !amountError && !busy && !submittedDigest;
  byId('redeem').disabled = !canRedeem;
  const label = busy ? phase : submittedDigest ? 'Refreshing after redemption…' : !account ? 'Connect wallet to redeem' : !usable ? 'Waiting for live balances…' : !open ? 'Redemption not open yet' : state.walletBalance === 0n ? 'No GOVEX to redeem' : 'Redeem GOVEX for USDC';
  byId('redeem').replaceChildren(document.createTextNode(label));
  if (canRedeem) { const arrow = document.createElement('span'); arrow.textContent = '↗'; arrow.setAttribute('aria-hidden', 'true'); byId('redeem').append(arrow); }
}

async function refresh() {
  if (busy) return;
  const thisRequest = ++requestId;
  const address = currentAccount()?.address ?? null;
  const previousLoadError = loadError;
  loading = true;
  render();
  try {
    let fresh = await loadRedemption(client, address);
    if (thisRequest !== requestId || address !== (currentAccount()?.address ?? null)) return;
    if (submittedDigest) {
      // Keep claims disabled until the fullnode has observed the submitted claim.
      await client.waitForTransaction({ digest: submittedDigest, timeout: 15_000 });
      fresh = await loadRedemption(client, address);
      if (thisRequest !== requestId || address !== (currentAccount()?.address ?? null)) return;
      submittedDigest = null;
      useMax = true;
    }
    state = fresh;
    loadError = '';
    if (address && useMax) amountInput.value = formatAmount(state.walletBalance, GOVEX.assetDecimals);
    if (previousLoadError && byId('message').textContent === previousLoadError) showMessage('');
  } catch (error) {
    if (thisRequest !== requestId) return;
    loadError = error instanceof Error ? error.message : 'Could not load the redemption pool.';
    showMessage(submittedDigest ? 'Redemption submitted. Use the transaction link to check its status; balances will refresh automatically.' : loadError, !submittedDigest);
  } finally {
    if (thisRequest === requestId) { loading = false; render(); }
  }
}

kit.stores.$connection.subscribe((connection) => {
  const address = connection.account?.address ?? null;
  if (address === lastAddress) return;
  lastAddress = address;
  ++requestId;
  state = null;
  loadError = '';
  useMax = true;
  amountInput.value = '';
  if (!busy && !submittedDigest) { showMessage(''); byId('receipt').hidden = true; }
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
byId('claim-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const account = currentAccount();
  if (!account || busy || byId('redeem').disabled) return;
  const address = account.address;
  const redeemMax = useMax;
  const requestedAmount = parseAmount(amountInput.value);
  let awaitingWalletResult = false;
  busy = true;
  ++requestId;
  loading = false;
  phase = 'Checking your redemption…';
  showMessage('');
  byId('receipt').hidden = true;
  render();
  try {
    const fresh = await loadRedemption(client, address);
    const amount = redeemMax ? fresh.walletBalance : requestedAmount;
    validateClaim(fresh, amount);
    if (currentAccount()?.address !== address) throw new Error('Your wallet changed. Try again with the current wallet.');
    state = fresh;
    amountInput.value = formatAmount(amount, GOVEX.assetDecimals);
    const tx = buildClaimTransaction(address, amount);
    const bytes = await tx.build({ client });
    const simulation = await client.simulateTransaction({ transaction: bytes, signal: AbortSignal.timeout(20_000) });
    if (simulation.FailedTransaction) throw new Error(simulation.FailedTransaction.status.error?.message ?? 'The redemption transaction could not be completed.');
    if (currentAccount()?.address !== address) throw new Error('Your wallet changed. Try again with the current wallet.');
    phase = 'Confirm in your wallet…';
    render();
    awaitingWalletResult = true;
    const result = await kit.signAndExecuteTransaction({ transaction: Transaction.from(bytes), account, network: GOVEX.network });
    awaitingWalletResult = false;
    const transaction = result.Transaction ?? result.FailedTransaction;
    if (transaction?.digest) {
      byId('receipt').href = `https://suiscan.xyz/mainnet/tx/${encodeURIComponent(transaction.digest)}`;
      byId('receipt').hidden = false;
    }
    if (result.FailedTransaction) throw new Error(result.FailedTransaction.status.error?.message ?? 'The transaction failed.');
    if (!result.Transaction) throw new Error('The wallet did not return a transaction result. Check your wallet before trying again.');
    submittedDigest = result.Transaction.digest;
    showMessage('GOVEX redeemed. Your USDC was sent to the wallet that signed the transaction.');
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Redemption failed.';
    showMessage(awaitingWalletResult ? `${detail} Check your wallet’s transaction history before retrying.` : detail, true);
  } finally {
    busy = false;
    phase = '';
    render();
    void refresh();
  }
});

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
