import { Contract } from '@algorandfoundation/tealscript';

// eslint-disable-next-line no-unused-vars
class AssetStaker extends Contract {
  // the asset we want to be staked
  stakeAsset = GlobalStateKey<Asset>({ key: 'sa' });

  // what asset will be reward
  rewardAsset = GlobalStateKey<Asset>({ key: 'ra' });

  // what rate are rewards sent out? per second
  rewardRate = GlobalStateKey<uint64>({ key: 'rr' });

  // how many rewards are available?
  totalRewards = GlobalStateKey<uint64>({ key: 'tr' });

  // total combined for all users
  totalStaked = GlobalStateKey<uint64>({ key: 'ts' });

  // when the staking period begins (UNIX ts)
  startTimestamp = GlobalStateKey<uint64>({ key: 'st' });

  // when the staking period ends (UNIX ts)
  finishTimestamp = GlobalStateKey<uint64>({ key: 'fi' });

  // when the global app was last updated
  lastUpdated = GlobalStateKey<uint64>({ key: 'lu' });

  // what is the users stake
  userStake = LocalStateKey<uint64>({ key: 'us' });

  // unclaimed rewards
  userPendingRewards = LocalStateKey<uint64>({ key: 'up' });

  // when user last interacted with the app
  userLastUpdated = LocalStateKey<uint64>({ key: 'ul' });

  private optIntoAsset(asset: Asset): void {
    // Submit opt-in transaction: 0 asset transfer to self
    sendAssetTransfer({
      assetReceiver: this.app.address,
      xferAsset: asset,
      assetAmount: 0,
    });
  }

  private getRewardPerToken(account: Account): uint64 {
    if (this.totalStaked.value === 0) {
      return 0;
    }

    const end =
      globals.latestTimestamp > this.finishTimestamp.value ? this.finishTimestamp.value : globals.latestTimestamp;

    const start =
      this.userLastUpdated(account).value < this.startTimestamp.value
        ? this.startTimestamp.value
        : this.userLastUpdated(account).value;

    // calculate how many seconds have passed
    const duration = end - start;

    return duration * this.rewardRate.value;
  }

  //
  private calculateRewards(account: Account): void {
    if (globals.latestTimestamp < this.startTimestamp.value) {
      return;
    }

    if (this.userLastUpdated(account).value > this.finishTimestamp.value) {
      return;
    }

    const rewardsPerToken = this.getRewardPerToken(account);
    const amountStaked = this.userStake(account).value;

    const rewardsEarned = amountStaked * rewardsPerToken;

    // update user local state with their rewards earned
    this.userPendingRewards(account).value = this.userPendingRewards(account).value + rewardsEarned;
    // remove rewards from total reward supply
    this.totalRewards.value = this.totalRewards.value - rewardsEarned;

    // update local lastUpdated
    this.userLastUpdated(account).value = globals.latestTimestamp;
    // update global lastUpdated
    this.lastUpdated.value = globals.latestTimestamp;
  }

  // need this method so user can opt-in to create local state
  optInToApplication(): void {
    this.userLastUpdated(this.txn.sender).value = 0;
    this.userPendingRewards(this.txn.sender).value = 0;
    this.userStake(this.txn.sender).value = 0;
  }

  createApplication(): void {
    this.stakeAsset.value = Asset.zeroIndex;
    this.rewardAsset.value = Asset.zeroIndex;
    this.totalRewards.value = 0;
    this.rewardRate.value = 0;
    this.totalStaked.value = 0;
    this.startTimestamp.value = 0;
    this.finishTimestamp.value = 0;
    this.lastUpdated.value = 0;
  }

  /**
   * Allows creator to initialize the app
   *
   * @param seed The `pay` txn to fund the app (0.2 min)
   * @param stakeAsset The asset to be staked
   * @param rewardAsset The asset to pay rewards
   * @param start The start time in UNIX time
   * @param finish The end time in UNIX time
   *
   * @returns void
   */
  bootstrap(seed: PayTxn, stakeAsset: Asset, rewardAsset: Asset, start: uint64, finish: uint64): void {
    // ensure begin is before end
    assert(start < finish);
    // check begin time, end time are in the future from now
    assert(globals.latestTimestamp < start);
    // ensure only the creator can bootstrap the app
    verifyTxn(this.txn, { sender: globals.creatorAddress });
    // ensure stakeAsset isn't set
    assert(this.stakeAsset.value === Asset.zeroIndex);
    // ensure rewardAsset isn't set
    assert(this.rewardAsset.value === Asset.zeroIndex);
    // should only be 2 txns in the group, app call, and an axfer
    assert(globals.groupSize === 2);

    const isAssetSame = stakeAsset === rewardAsset;
    const requiredAmount = isAssetSame ? 2_000 : 3_000; // 0.2 algos

    // seed txn must be enough to opt-in to both assets and fund the account
    verifyTxn(seed, { receiver: this.app.address, amount: { greaterThanEqualTo: requiredAmount } });

    this.optIntoAsset(stakeAsset);
    this.stakeAsset.value = stakeAsset;

    if (!isAssetSame) {
      this.optIntoAsset(rewardAsset);
      this.rewardAsset.value = rewardAsset;
    } else {
      this.rewardAsset.value = stakeAsset;
    }

    this.startTimestamp.value = start;
    this.finishTimestamp.value = finish;
  }

  /**
   * Allows contract to be funded with more rewards
   *
   * @param axfer The `axfer` funding the app with rewardAsset
   * @param rewardRate the uint64 value of how many rewards per second
   *
   * @returns uint64 - the total rewards (in rewardToken) remaining in the app
   */
  addRewards(axfer: AssetTransferTxn, rewardRate: uint64): uint64 {
    // ensure its the creator only doing the app call
    verifyTxn(this.txn, { sender: globals.creatorAddress });

    // txn assetAmount must be greater than zero
    verifyTxn(axfer, {
      sender: this.txn.sender,
      xferAsset: this.rewardAsset.value,
      assetReceiver: this.app.address,
      assetAmount: { greaterThan: 0 },
    });

    const newTotalRewards = this.totalRewards.value + axfer.assetAmount;
    // update global total rewards
    this.totalRewards.value = newTotalRewards;

    // reward rate must be more than 0
    assert(rewardRate > 0);

    // update global state
    this.rewardRate.value = rewardRate;

    return newTotalRewards;
  }

  /**
   * Allows users to stake tokens
   *
   * @param axfer The `axfer` funding the app with stakingAsset
   *
   * @returns uint64 - the total number of tokens user has staked
   */
  addStake(axfer: AssetTransferTxn): uint64 {
    verifyTxn(axfer, {
      sender: this.txn.sender,
      xferAsset: this.stakeAsset.value,
      assetAmount: { greaterThan: 0 },
      assetReceiver: this.app.address,
    });

    // calc rewards
    this.calculateRewards(this.txn.sender);

    const amount = axfer.assetAmount;

    // update global staked
    this.totalStaked.value = this.totalStaked.value + amount;
    // update local staked
    const newUserStake = this.userStake(this.txn.sender).value + amount;
    this.userStake(this.txn.sender).value = newUserStake;

    return newUserStake;
  }

  /**
   * Allows users to remove staked tokens
   *
   * @param asset The stakeTokenAsset (needs implicitly declared?)
   *
   * @returns uint64 - the total number of tokens user has staked (may be zero if all are removed)
   */
  removeStake(asset: Asset, amount: uint64): uint64 {
    // get the users current stake
    const stake = this.userStake(this.txn.sender).value;

    // ensure user can't unstake more than they have
    assert(amount <= stake);
    // must be passing the stakeAsset to withdraw
    assert(asset === this.stakeAsset.value);

    // calc rewards
    this.calculateRewards(this.txn.sender);

    // send user back
    sendAssetTransfer({
      xferAsset: asset,
      assetAmount: amount,
      assetReceiver: this.txn.sender,
    });

    // update global total staked
    this.totalStaked.value = this.totalStaked.value - amount;
    // update local user staked
    const newUserStake = this.userStake(this.txn.sender).value - amount;
    this.userStake(this.txn.sender).value = newUserStake;

    return newUserStake;
  }
}
