import { describe, test, beforeAll, beforeEach, expect } from '@jest/globals';
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing';
import {
  Account,
  Algodv2,
  makeAssetCreateTxnWithSuggestedParamsFromObject,
  makeAssetTransferTxnWithSuggestedParamsFromObject,
  makePaymentTxnWithSuggestedParamsFromObject,
} from 'algosdk';
import { algos, getTransactionParams, sendTransaction } from '@algorandfoundation/algokit-utils';
import { AssetStakerClient } from '../contracts/clients/AssetStakerClient';

const fixture = algorandFixture();

describe('AssetStaker', () => {
  let algod: Algodv2;
  // variables shared between tests
  let stakingAssetId: number;
  let assetStakerClient: AssetStakerClient;
  let assetStakerAppId: number | bigint;
  let assetStakerCreator: Account;

  // helper functions
  async function dispenseStakingAsset(to: string, amount: number) {
    const fundTestAccountTxn = makeAssetTransferTxnWithSuggestedParamsFromObject({
      from: assetStakerCreator.addr,
      to,
      assetIndex: stakingAssetId,
      amount, // 100 tokens
      suggestedParams: await getTransactionParams(undefined, algod),
    });

    await sendTransaction(
      {
        transaction: fundTestAccountTxn,
        from: assetStakerCreator,
      },
      algod
    );
  }

  async function optInAsset(from: Account, assetId: number) {
    // opt-in txn for user for the asset
    const optInTxn = makeAssetTransferTxnWithSuggestedParamsFromObject({
      from: from.addr,
      to: from.addr,
      amount: 0,
      assetIndex: assetId,
      suggestedParams: await getTransactionParams(undefined, algod),
    });

    // have them actually opt-in
    await sendTransaction({ transaction: optInTxn, from }, algod);
  }

  async function createNewAsset(from: Account) {
    const assetCreateTxn = makeAssetCreateTxnWithSuggestedParamsFromObject({
      from: from.addr,
      manager: from.addr,
      assetName: 'Test Asset',
      unitName: 'TEST',
      decimals: 1,
      total: 1_000_000,
      defaultFrozen: false,
      suggestedParams: await getTransactionParams(undefined, algod),
    });

    const res = await sendTransaction(
      {
        transaction: assetCreateTxn,
        from,
        sendParams: {},
      },
      algod
    );

    const { confirmation } = res;

    const assetId = confirmation?.assetIndex;

    if (assetId === undefined) {
      throw new Error('failed to create asset');
    }

    return assetId;
  }

  beforeEach(fixture.beforeEach);

  beforeAll(async () => {
    await fixture.beforeEach();
    const { testAccount } = fixture.context;

    // same algo instance
    algod = fixture.context.algod;

    assetStakerClient = new AssetStakerClient(
      {
        sender: testAccount,
        resolveBy: 'id',
        id: 0,
      },
      algod
    );

    await algod.setBlockOffsetTimestamp(1).do(); // make every block have 1s gap

    await assetStakerClient.create.createApplication({});

    const { appAddress, appId } = await assetStakerClient.appClient.getAppReference();

    // set global ref so client tests can use
    assetStakerAppId = appId;
    // set who created the app
    assetStakerCreator = testAccount;

    stakingAssetId = <number>await createNewAsset(testAccount);

    const params = await getTransactionParams(undefined, algod);

    // initial funding transaction, smart contract needs 0.1 to exist, 0.1 to be able to opt-in
    const seedTxn = makePaymentTxnWithSuggestedParamsFromObject({
      from: testAccount.addr,
      to: appAddress,
      amount: 200_000,
      suggestedParams: params,
    });

    // This only works in Sandbox, not AlgoKit Localnet, which doesn't advance blocks & time normally
    const start = Math.floor(Date.now() / 1000) + 30;
    const finish = start + 6000; // now + 600 secs

    await assetStakerClient.bootstrap(
      { seed: seedTxn, stakeAsset: stakingAssetId, rewardAsset: stakingAssetId, start, finish },
      { sendParams: { fee: algos(0.2) }, note: 'beforeAll_bootstrap' }
    );
  });

  test('addRewards', async () => {
    const { appAddress } = await assetStakerClient.appClient.getAppReference();

    const addRewardsTxn = makeAssetTransferTxnWithSuggestedParamsFromObject({
      from: assetStakerCreator.addr,
      to: appAddress,
      assetIndex: stakingAssetId,
      amount: 10_000 * 10, // 10k rewards
      suggestedParams: await getTransactionParams(undefined, algod),
    });

    await assetStakerClient.addRewards({ axfer: addRewardsTxn, rewardRate: 1 });
  });

  test('addStake', async () => {
    const { testAccount } = fixture.context;

    // have test user opt-in
    await optInAsset(testAccount, stakingAssetId);
    // send them 100 test tokens
    await dispenseStakingAsset(testAccount.addr, 100 * 10);

    const assetStakerUserClient = new AssetStakerClient(
      { sender: testAccount, resolveBy: 'id', id: assetStakerAppId },
      algod
    );

    // opt in so we can get a local state
    await assetStakerUserClient.optIn.optInToApplication({});
    // get the app address
    const { appAddress } = await assetStakerUserClient.appClient.getAppReference();

    const axferTxn = makeAssetTransferTxnWithSuggestedParamsFromObject({
      from: testAccount.addr,
      to: appAddress,
      assetIndex: stakingAssetId,
      amount: 100 * 10, // 100 tokens
      suggestedParams: await getTransactionParams(undefined, algod),
    });

    await expect(
      assetStakerUserClient.addStake({ axfer: axferTxn }, { note: 'addStake_addStake' })
    ).resolves.not.toThrowError();
  });

  test('removeStake', async () => {
    const { generateAccount } = fixture.context;

    const testUser = await generateAccount({ initialFunds: algos(1) });
    // have test user opt-in
    await optInAsset(testUser, stakingAssetId);
    // send them 100 test tokens
    await dispenseStakingAsset(testUser.addr, 100 * 10);

    const assetStakerUserClient = new AssetStakerClient(
      { sender: testUser, resolveBy: 'id', id: assetStakerAppId },
      algod
    );
    // opt in so we can get a local state
    await assetStakerUserClient.optIn.optInToApplication({});
    // get the app address
    const { appAddress } = await assetStakerUserClient.appClient.getAppReference();

    const axferTxn = makeAssetTransferTxnWithSuggestedParamsFromObject({
      from: testUser.addr,
      to: appAddress,
      assetIndex: stakingAssetId,
      amount: 100 * 10, // 100 tokens
      suggestedParams: await getTransactionParams(undefined, algod),
    });

    await assetStakerUserClient.addStake({ axfer: axferTxn }, { note: 'removeStake_addStake' });

    // call removeStake endpoint
    await expect(
      assetStakerUserClient.removeStake(
        { asset: stakingAssetId, amount: 100 * 10 },
        { note: 'removeStake_removeStake', sendParams: { fee: algos(0.002) } }
      )
    ).resolves.not.toThrowError();
  });

  test('claimRewards', async () => {
    const { testAccount } = fixture.context;

    // have test user opt-in
    await optInAsset(testAccount, stakingAssetId);
    // send them 100 test tokens
    await dispenseStakingAsset(testAccount.addr, 100 * 10);

    const assetStakerUserClient = new AssetStakerClient(
      { sender: testAccount, resolveBy: 'id', id: assetStakerAppId },
      algod
    );

    // opt in so we can get a local state
    await assetStakerUserClient.optIn.optInToApplication({});
    // get the app address
    const { appAddress } = await assetStakerUserClient.appClient.getAppReference();

    const axferTxn = makeAssetTransferTxnWithSuggestedParamsFromObject({
      from: testAccount.addr,
      to: appAddress,
      assetIndex: stakingAssetId,
      amount: 100 * 10, // 100 tokens
      suggestedParams: await getTransactionParams(undefined, algod),
    });

    await algod.setBlockOffsetTimestamp(30).do();

    await assetStakerUserClient.addStake({ axfer: axferTxn }, { note: 'claimRewards_addStake' });

    await expect(
      assetStakerUserClient.claimRewards(
        { asset: stakingAssetId },
        { note: 'claimRewards_claimRewards', sendParams: { fee: algos(0.002) } }
      )
    ).resolves.not.toThrowError();
  });
});
