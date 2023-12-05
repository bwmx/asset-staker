import { describe, test, beforeAll, beforeEach, expect, jest } from '@jest/globals';
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing';
import {
  Account,
  Algodv2,
  makeAssetCreateTxnWithSuggestedParamsFromObject,
  makeAssetTransferTxnWithSuggestedParamsFromObject,
  makePaymentTxnWithSuggestedParamsFromObject,
} from 'algosdk';
import { algos, sendTransaction } from '@algorandfoundation/algokit-utils';
import { AssetStakerClient } from '../contracts/clients/AssetStakerClient';

jest.useFakeTimers();

const fixture = algorandFixture();

let assetStakerClient: AssetStakerClient;
let assetStakerAppId: number | bigint;
let assetStakerCreator: Account;
let createdAssetId: number;

// some helpers
async function createNewAsset(from: Account, algod: Algodv2) {
  const params = await algod.getTransactionParams().do();

  const assetCreateTxn = makeAssetCreateTxnWithSuggestedParamsFromObject({
    from: from.addr,
    manager: from.addr,
    assetName: 'Test Asset',
    unitName: 'TEST',
    decimals: 1,
    total: 1_000_000,
    defaultFrozen: false,
    suggestedParams: params,
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

async function optInAsset(from: Account, assetId: number | bigint, algod: Algodv2) {
  // opt-in txn for user for the asset
  const optInTxn = makeAssetTransferTxnWithSuggestedParamsFromObject({
    from: from.addr,
    to: from.addr,
    amount: 0,
    assetIndex: <number>createdAssetId,
    suggestedParams: await algod.getTransactionParams().do(),
  });

  // have them actually opt-in
  await sendTransaction({ transaction: optInTxn, from }, algod);
}

async function dispenseAsset(to: string, amount: number, algod: Algodv2) {
  const fundTestAccountTxn = makeAssetTransferTxnWithSuggestedParamsFromObject({
    from: assetStakerCreator.addr,
    to,
    assetIndex: createdAssetId,
    amount, // 100 tokens
    suggestedParams: await algod.getTransactionParams().do(),
  });

  await sendTransaction(
    {
      transaction: fundTestAccountTxn,
      from: assetStakerCreator,
    },
    algod
  );
}

describe('AssetStaker', () => {
  beforeEach(fixture.beforeEach);

  beforeAll(async () => {
    await fixture.beforeEach();
    const { algod, testAccount } = fixture.context;

    assetStakerClient = new AssetStakerClient(
      {
        sender: testAccount,
        resolveBy: 'id',
        id: 0,
      },
      algod
    );

    await assetStakerClient.create.createApplication({});

    const { appAddress, appId } = await assetStakerClient.appClient.getAppReference();

    // set global ref so client tests can use
    assetStakerAppId = appId;

    // set who created the app
    assetStakerCreator = testAccount;

    createdAssetId = <number>await createNewAsset(testAccount, algod);

    const params = await algod.getTransactionParams().do();

    // initial funding transaction, smart contract needs 0.1 to exist, 0.1 to be able to opt-in
    const seedTxn = makePaymentTxnWithSuggestedParamsFromObject({
      from: testAccount.addr,
      to: appAddress,
      amount: 200_000,
      suggestedParams: params,
    });

    // This only works in Sandbox, not AlgoKit Localnet, which doesn't advance blocks & time normally
    const start = Math.floor(Date.now() / 1000) + 30;
    const finish = start + 600; // now + 600 secs
    console.debug(`Timestamps: Start: ${start} Finish: ${finish}`);

    await assetStakerClient.bootstrap(
      { seed: seedTxn, stakeAsset: createdAssetId, rewardAsset: createdAssetId, start, finish },
      { sendParams: { fee: algos(0.2) } }
    );
  });

  test('addRewards', async () => {
    const { algod } = fixture.context;

    const { appAddress } = await assetStakerClient.appClient.getAppReference();

    const addRewardsTxn = makeAssetTransferTxnWithSuggestedParamsFromObject({
      from: assetStakerCreator.addr,
      to: appAddress,
      assetIndex: createdAssetId,
      amount: 10_000 * 10, // 10k rewards
      suggestedParams: await algod.getTransactionParams().do(),
    });

    await assetStakerClient.addRewards({ axfer: addRewardsTxn, rewardRate: 1 });
  });

  test('addStake', async () => {
    const { generateAccount, algod } = fixture.context;

    const testUser = await generateAccount({ initialFunds: algos(1) });
    // have test user opt-in
    await optInAsset(testUser, createdAssetId, algod);
    // send them 100 test tokens
    await dispenseAsset(testUser.addr, 100 * 10, algod);

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
      assetIndex: createdAssetId,
      amount: 100 * 10, // 100 tokens
      suggestedParams: await algod.getTransactionParams().do(),
    });

    await expect(assetStakerUserClient.addStake({ axfer: axferTxn })).resolves.not.toThrowError();
  });

  test('removeStake', async () => {
    const { generateAccount, algod } = fixture.context;

    const testUser = await generateAccount({ initialFunds: algos(1) });
    // have test user opt-in
    await optInAsset(testUser, createdAssetId, algod);
    // send them 100 test tokens
    await dispenseAsset(testUser.addr, 100 * 10, algod);

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
      assetIndex: createdAssetId,
      amount: 100 * 10, // 100 tokens
      suggestedParams: await algod.getTransactionParams().do(),
    });

    await assetStakerUserClient.addStake({ axfer: axferTxn });

    async function cb() {
      // call removeStake endpoint
      await expect(
        assetStakerUserClient.removeStake(
          { asset: createdAssetId, amount: 100 * 10 },
          { sendParams: { fee: algos(0.002) } }
        )
      ).resolves.not.toThrowError();
    }

    setTimeout(() => {
      cb();
    }, 10_000);

    jest.advanceTimersByTime(10_000);
  });
});
