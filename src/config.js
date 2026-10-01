// Public Sui mainnet deployment. No backend, database, or environment variables.
export const GOVEX = Object.freeze({
  network: 'mainnet',
  grpcUrl: 'https://fullnode.mainnet.sui.io:443',
  daoId: '0x2d6e466623b393e69a476bb22dc96aff388ec18d1d6da4c821d12c36456eea1a',
  poolId: '0x06526cd01b991460e0df74f9e77af8d57dc6fd9a9dde70b6affa52c19ce3eb5b',
  capabilityId: '0xa00a02d0378818707e74e6b6ecef4f4d44c5c369925b932f7ba8fbf4c2965b6f',
  actionsPackageId: '0x17fca531a63ee76e437f6cc579d82171a1ec6163cd6e37cd7216f50906ad6bab',
  originalActionsPackageId: '0x12cb3c69cbbfb1e8e647993dd8a83b4624a81c815ee867af8f5c5be3933e0839',
  packageRegistryId: '0x18a757fc41d71da5555751541ff98155f47f81429bb8a15df71b435e1e36a677',
  accountPackageId: '0x0f6ef484a0867ccffe219fa1f4648e58f8c3fd04a4ddcfb318a27f9cc6d2f3d9',
  assetType: '0x0f5a49f57d89b812eface201194381d5c81b462f39b90b220a024750737ea5d4::govex::GOVEX',
  redeemCoinType: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
  assetDecimals: 9,
  redeemCoinDecimals: 6,
  clockId: '0x6',
});
