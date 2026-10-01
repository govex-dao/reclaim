# Govex Reclaim

A standalone static page for redeeming GOVEX for USDC from the Govex DAO redemption pool on Sui mainnet. Holders connect a Sui wallet, choose some or all of their GOVEX, and receive their proportional share of the pool. Redeemed GOVEX is permanently burned.

The app reads directly from public Sui gRPC. It needs no Govex website, backend, indexer, database, API keys, environment variables, or Govex SDK. Plain HTML, CSS, and JavaScript, with Mysten's Sui SDK and wallet components bundled at build time.

## Run

Use Node.js 22.12 or newer.

```sh
npm ci
npm run dev
```

## Build and host

```sh
npm test
npm run build
```

Publish the contents of `dist/` to any HTTPS static host, including GitHub Pages, Cloudflare Pages, or Netlify. Set the build command to `npm run build` and output directory to `dist`. The relative asset paths support hosting at `/reclaim/` as well as a domain root. There is no server process to maintain after building. For local testing of the build, run `npm run preview`.

Wallet extensions require a served page: use HTTPS in production or localhost for development, rather than opening `index.html` directly with `file://`.

## Public deployment configuration

All fixed values are in [`src/config.js`](src/config.js): the DAO, pool, capability, claim package, original package for struct identity, package registry, clock, both coin types, token decimals, and public mainnet gRPC endpoint. No other project or DAO is supported. Contract addresses here identify public on-chain contracts, not personal contact information or private wallet credentials.

Live balances, circulating supply, and the unlock time are read from Sui. They are intentionally not fixed: successful claims and external burns change them. Estimates use integer arithmetic matching the deployed Move claim, including rounding down to USDC's six decimal places. The app verifies the pool's type, DAO and capability before enabling redemption, refreshes before submission, simulates the transaction, and signs explicitly on mainnet. Coin selection supports multiple coin objects and Sui address balances. A holder needs SUI for gas.

To verify the fixed deployment against mainnet without connecting a wallet or submitting anything:

```sh
npm run verify:mainnet
```

The only runtime services are Sui's public mainnet node and the holder's wallet. Explorer links open Suiscan when clicked. There are no analytics or external fonts. Wallet connection preferences are saved in the holder's browser by dApp Kit. No private keys or seed phrases are requested. The public node has rate limits; a different public gRPC endpoint can be set in `src/config.js` and rebuilt if needed.

Built using the official [Mysten Sui client](https://sdk.mystenlabs.com/sui/clients/querying) and [dApp Kit](https://sdk.mystenlabs.com/dapp-kit/actions/sign-and-execute-transaction).

## Verification scope

Unit tests cover exact amounts, rounding, pool identity, circulating supply changes, claim eligibility, and the transaction's target, types, object arguments, and payout recipient. The mainnet check verifies the live objects and deployed function signature. These checks do not submit a live redemption; the final signing and execution happen in the holder's own wallet.
