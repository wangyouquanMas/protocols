import BN = require("bn.js");
import { Constants, roundToFloatValue } from "loopringV3.js";
import { expectThrow } from "./expectThrow";
import { BalanceSnapshot, ExchangeTestUtil } from "./testExchangeUtil";
import { AuthMethod, Deposit, SpotTrade, OrderInfo } from "./types";

contract("Exchange", (accounts: string[]) => {
  let exchangeTestUtil: ExchangeTestUtil;
  let exchange: any;
  let depositContract: any;
  let loopring: any;
  let exchangeID = 0;

  const depositChecked = async (
    from: string,
    to: string,
    token: string,
    amount: BN
  ) => {
    const snapshot = new BalanceSnapshot(exchangeTestUtil);
    await snapshot.watchBalance(to, token, "recipient");
    await snapshot.transfer(
      from,
      depositContract.address,
      token,
      amount,
      "from",
      "depositContract"
    );

    const ethAddress = exchangeTestUtil.getTokenAddress("ETH");
    const ethValue = token === ethAddress ? amount : 0;
    // Deposit
    await exchange.deposit(from, to, token, amount, "0x", {
      from: from,
      value: ethValue,
      gasPrice: 0
    });

    // Verify balances
    await snapshot.verifyBalances();

    // Get the Deposit event
    const event = await exchangeTestUtil.assertEventEmitted(
      exchange,
      "DepositRequested"
    );
    assert.equal(event.to, to, "owner unexpected");
    assert.equal(
      event.token,
      exchangeTestUtil.getTokenAddress(token),
      "token unexpected"
    );
    assert(event.amount.eq(amount), "amount unexpected");
  };

  const submitWithdrawalBlockChecked = async (
    deposits: Deposit[],
    expectedSuccess?: boolean[],
    expectedTo?: string[],
    blockFee?: BN
  ) => {
    assert.equal(
      exchangeTestUtil.pendingBlocks[exchangeID].length,
      1,
      "unexpected number of pending blocks"
    );
    const block = exchangeTestUtil.pendingBlocks[exchangeID][0];

    // Block fee
    const feeRecipient = exchangeTestUtil.exchangeOperator;
    blockFee = new BN(0);
    let numWithdrawals = 0;
    for (const tx of block.internalBlock.transactions) {
      if (tx.txType === "Withdraw") {
        numWithdrawals++;
        if (tx.type >= 2) {
          blockFee.iadd(tx.withdrawalFee);
        }
      } else if (tx.txType === "Deposit") {
      }
    }

    if (expectedSuccess === undefined) {
      expectedSuccess = new Array(numWithdrawals).fill(true);
    }

    if (expectedTo === undefined) {
      expectedTo = new Array(deposits.length).fill(Constants.zeroAddress);
      for (const [i, deposit] of deposits.entries()) {
        expectedTo[i] =
          deposit.owner === Constants.zeroAddress
            ? await loopring.protocolFeeVault()
            : deposit.owner;
      }
    }

    // Simulate all transfers
    const snapshot = new BalanceSnapshot(exchangeTestUtil);
    // Simulate withdrawals
    for (const [i, deposit] of deposits.entries()) {
      await snapshot.transfer(
        depositContract.address,
        expectedTo[i],
        deposit.token,
        expectedSuccess[i] ? deposit.amount : new BN(0),
        "depositContract",
        "to"
      );
    }
    // Simulate block fee payment
    // await snapshot.transfer(
    //   exchange.address,
    //   feeRecipient,
    //   "ETH",
    //   blockFee,
    //   "exchange",
    //   "feeRecipient"
    // );

    // Submit the block
    await exchangeTestUtil.submitPendingBlocks();

    // Verify balances
    await snapshot.verifyBalances();

    // Check events
    // WithdrawalCompleted events
    {
      const numEventsExpected = expectedSuccess.filter(x => x === true).length;
      const events = await exchangeTestUtil.assertEventsEmitted(
        exchange,
        "WithdrawalCompleted",
        numEventsExpected
      );
      let c = 0;
      for (const [i, deposit] of deposits.entries()) {
        if (expectedSuccess[i]) {
          assert.equal(events[c].from, deposit.owner, "from should match");
          assert.equal(events[c].to, expectedTo[i], "to should match");
          assert.equal(events[c].token, deposit.token, "token should match");
          assert(events[c].amount.eq(deposit.amount), "amount should match");
          c++;
        }
      }
      assert.equal(
        events.length,
        c,
        "Unexpected num WithdrawalCompleted events"
      );
    }
    // WithdrawalFailed events
    {
      const numEventsExpected = expectedSuccess.filter(x => x === false).length;
      const events = await exchangeTestUtil.assertEventsEmitted(
        exchange,
        "WithdrawalFailed",
        numEventsExpected
      );
      let c = 0;
      for (const [i, deposit] of deposits.entries()) {
        if (!expectedSuccess[i]) {
          assert.equal(events[c].from, deposit.owner, "from should match");
          assert.equal(events[c].to, expectedTo[i], "to should match");
          assert.equal(events[c].token, deposit.token, "token should match");
          assert(events[c].amount.eq(deposit.amount), "amount should match");
          c++;
        }
      }
      assert.equal(events.length, c, "Unexpected num WithdrawalFailed events");
    }

    // Check the BlockSubmitted event
    const event = await exchangeTestUtil.assertEventEmitted(
      exchange,
      "BlockSubmitted"
    );
    assert.equal(
      event.blockIdx.toNumber(),
      block.blockIdx,
      "Unexpected block idx"
    );
  };

  const withdrawOnceChecked = async (
    owner: string,
    token: string,
    expectedAmount: BN
  ) => {
    const snapshot = new BalanceSnapshot(exchangeTestUtil);
    await snapshot.transfer(
      depositContract.address,
      owner,
      token,
      expectedAmount,
      "depositContract",
      "owner"
    );

    // Check how much will be withdrawn
    const onchainAmountWithdrawableBefore = await exchange.getAmountWithdrawable(
      owner,
      token
    );
    assert(
      onchainAmountWithdrawableBefore.eq(expectedAmount),
      "unexpected withdrawable amount"
    );

    await exchange.withdrawFromApprovedWithdrawals([owner], [token], {
      from: exchangeTestUtil.testContext.orderOwners[10]
    });

    // Complete amount needs to be withdrawn
    const onchainAmountWithdrawableAfter = await exchange.getAmountWithdrawable(
      owner,
      token
    );
    assert(
      onchainAmountWithdrawableAfter.eq(new BN(0)),
      "unexpected withdrawable amount"
    );

    // Verify balances
    await snapshot.verifyBalances();

    // Get the WithdrawalCompleted event
    const event = await exchangeTestUtil.assertEventEmitted(
      exchange,
      "WithdrawalCompleted"
    );
    assert.equal(event.from, owner, "from unexpected");
    assert.equal(event.to, owner, "to unexpected");
    assert.equal(event.token, token, "token unexpected");
    assert(event.amount.eq(expectedAmount), "amount unexpected");
  };

  const withdrawChecked = async (
    owner: string,
    token: string,
    expectedAmount: BN
  ) => {
    // Withdraw
    await withdrawOnceChecked(owner, token, expectedAmount);
    // Withdraw again, no tokens should be transferred
    await withdrawOnceChecked(owner, token, new BN(0));
  };

  const createExchange = async (setupTestState: boolean = true) => {
    exchangeID = await exchangeTestUtil.createExchange(
      exchangeTestUtil.testContext.stateOwners[0],
      { setupTestState }
    );
    exchange = exchangeTestUtil.exchange;
    depositContract = exchangeTestUtil.depositContract;
  };

  before(async () => {
    exchangeTestUtil = new ExchangeTestUtil();
    await exchangeTestUtil.initialize(accounts);
    exchange = exchangeTestUtil.exchange;
    loopring = exchangeTestUtil.loopringV3;
    depositContract = exchangeTestUtil.depositContract;
    exchangeID = 1;
  });

  after(async () => {
    await exchangeTestUtil.stop();
  });

  describe("DepositWithdraw", function() {
    this.timeout(0);

    it("zero test", async () => {
      await createExchange();

      const ownerA = exchangeTestUtil.testContext.orderOwners[0];
      const ownerB = exchangeTestUtil.testContext.orderOwners[1];
      const balance = new BN(web3.utils.toWei("7", "ether"));
      const fee = new BN(web3.utils.toWei("0.1", "ether"));
      const token = exchangeTestUtil.getTokenAddress("LRC");
      const recipient = ownerB;

      /*
        const deposit1 = await exchangeTestUtil.deposit(
          ownerA,
          ownerA,
          token,
          new BN(web3.utils.toWei("700000000", "ether"))
        );*/
      /*let newKeyPair = exchangeTestUtil.getKeyPairEDDSA();
        for (var i = 0; i < 256; i++) {
          const accountUpdate = await exchangeTestUtil.requestAccountUpdate(
            ownerA,
            token,
            fee,
            newKeyPair,
            {
              authMethod: AuthMethod.ECDSA
            }
          );
        }*/

      /*for (var i = 0; i < 256; i++) {
          const deposit2 = await exchangeTestUtil.deposit(
            ownerA,
            ownerA,
            token,
            balance
          );
        }*/
      /*
        for(var i = 0; i < 2; i++) {
          // Do the withdrawal request
          const request = await exchangeTestUtil.requestWithdrawal(
            ownerA,
            token,
            balance,
            "ETH",
            new BN(0),
            { authMethod: AuthMethod.EDDSA, storeRecipient: true }
          );
        }*/

      /*
        const depositOwner3 = await exchangeTestUtil.deposit(
          exchangeTestUtil.testContext.orderOwners[3],
          exchangeTestUtil.testContext.orderOwners[3],
          "LRC",
          new BN(web3.utils.toWei("20000000000", "ether"))
        );
  
        console.log("owner:" + exchangeTestUtil.testContext.orderOwners[3]);
        
        for (var i = 0; i < 8; i++) {
          await exchangeTestUtil.transfer(
            exchangeTestUtil.testContext.orderOwners[3],
            ownerB,
            token,
            balance,
            token,
            fee,
            {
              authMethod: AuthMethod.APPROVE
            }
          );
        }*/
      const depositTo3 = await exchangeTestUtil.deposit(
        exchangeTestUtil.testContext.orderOwners[3],
        exchangeTestUtil.testContext.orderOwners[3],
        "GTO",
        new BN(web3.utils.toWei("200", "ether")),
        { autoSetKeys: false }
      );
      const depositTo3WETH = await exchangeTestUtil.deposit(
        exchangeTestUtil.testContext.orderOwners[3],
        exchangeTestUtil.testContext.orderOwners[3],
        "WETH",
        new BN(web3.utils.toWei("200", "ether")),
        { autoSetKeys: false }
      );
      // account update
      let keyPair = exchangeTestUtil.getKeyPairEDDSA();
      await exchangeTestUtil.requestAccountUpdate(
        exchangeTestUtil.testContext.orderOwners[3],
        "WETH",
        new BN(web3.utils.toWei("0.03", "ether")),
        keyPair,
        {
          authMethod: AuthMethod.ECDSA
        }
      );
      // await exchangeTestUtil.requestAccountUpdate(exchangeTestUtil.testContext.orderOwners[3], "GTO", new BN(0), keyPair, {
      //   authMethod: AuthMethod.ECDSA
      // }, 2);

      // transfer
      await exchangeTestUtil.transfer(
        exchangeTestUtil.testContext.orderOwners[3],
        exchangeTestUtil.testContext.orderOwners[2],
        "GTO",
        new BN(web3.utils.toWei("2", "ether")),
        "WETH",
        new BN(web3.utils.toWei("0.01", "ether")),
        {
          authMethod: AuthMethod.EDDSA
        }
      );
      // withdraw
      const requestWithdraw = await exchangeTestUtil.requestWithdrawal(
        exchangeTestUtil.testContext.orderOwners[3],
        "GTO",
        new BN(web3.utils.toWei("2", "ether")),
        "WETH",
        new BN(web3.utils.toWei("0.02", "ether")),
        { authMethod: AuthMethod.EDDSA, storeRecipient: true }
      );
      // await exchangeTestUtil.requestAccountUpdate(exchangeTestUtil.testContext.orderOwners[3], "GTO", new BN(0), keyPair, {
      //   authMethod: AuthMethod.ECDSA
      // }, 2);

      const depositGTOOwner1 = await exchangeTestUtil.deposit(
        exchangeTestUtil.testContext.orderOwners[1],
        exchangeTestUtil.testContext.orderOwners[1],
        "GTO",
        new BN(web3.utils.toWei("200", "ether"))
      );

      const depositWETHOwner1 = await exchangeTestUtil.deposit(
        exchangeTestUtil.testContext.orderOwners[1],
        exchangeTestUtil.testContext.orderOwners[1],
        "WETH",
        new BN(web3.utils.toWei("100", "ether"))
      );

      const depositETHOwner1 = await exchangeTestUtil.deposit(
        exchangeTestUtil.testContext.orderOwners[1],
        exchangeTestUtil.testContext.orderOwners[1],
        "ETH",
        new BN(web3.utils.toWei("20", "ether"))
      );

      const depositGTOOwner0 = await exchangeTestUtil.deposit(
        exchangeTestUtil.testContext.orderOwners[1],
        exchangeTestUtil.testContext.orderOwners[1],
        "GTO",
        new BN(web3.utils.toWei("200", "ether"))
      );

      const depositWETHOwner0 = await exchangeTestUtil.deposit(
        exchangeTestUtil.testContext.orderOwners[0],
        exchangeTestUtil.testContext.orderOwners[0],
        "WETH",
        new BN(web3.utils.toWei("100", "ether"))
      );

      const depositETHOwner0 = await exchangeTestUtil.deposit(
        exchangeTestUtil.testContext.orderOwners[0],
        exchangeTestUtil.testContext.orderOwners[0],
        "ETH",
        new BN(web3.utils.toWei("20", "ether"))
      );

      for (var i = 0; i < 1; i++) {
        // spot trade
        const order: OrderInfo = {
          tokenS: "WETH",
          tokenB: "GTO",
          amountS: new BN(web3.utils.toWei("1", "ether")),
          amountB: new BN(web3.utils.toWei("0.5", "ether")),
          owner: exchangeTestUtil.testContext.orderOwners[0],
          // maxFeeBips: 50,
          feeBips: 18,
          tradingFee: new BN("12300000000000"),
          fillAmountBorS: true,
          feeTokenID: 3,
          fee: new BN("12300000000000"),
          maxFee: new BN("12300000000000")
        };

        const spread = new BN(web3.utils.toWei("1", "ether"));
        const ringA: SpotTrade = {
          orderA: order,
          orderB: {
            tokenS: "GTO",
            tokenB: "WETH",
            amountS: new BN(web3.utils.toWei("4", "ether")),
            amountB: new BN(web3.utils.toWei("2", "ether")),
            owner: exchangeTestUtil.testContext.orderOwners[1],
            feeBips: 0,
            fillAmountBorS: false,
            feeTokenID: 0,
            fee: new BN("21000000000000"),
            maxFee: new BN("21000000000000")
          },
          expected: {
            orderA: { filledFraction: 1.0, spread },
            orderB: { filledFraction: 0.5 }
          }
        };

        await exchangeTestUtil.setupRing(ringA, true, true, false, false);
        await exchangeTestUtil.sendRing(ringA);
      }

      exchangeTestUtil.reserveMultiStorageID(1024);
      const autoMarketOrderA: OrderInfo = {
        tokenS: "WETH",
        tokenB: "GTO",
        amountS: new BN(web3.utils.toWei("1", "ether")),
        amountB: new BN(web3.utils.toWei("0.495", "ether")),
        owner: exchangeTestUtil.testContext.orderOwners[0],
        feeBips: 18,
        fillAmountBorS: false,
        feeTokenID: 0,
        fee: new BN("12300000000000"),
        maxFee: new BN("12300000000000"),
        uiReferID: 3,
        type: 6,
        level: 0,
        isNextOrder: false,
        // maxLevel: 255,
        maxLevel: 10,
        gridOffset: new BN(web3.utils.toWei("0.0005", "ether")),
        orderOffset: new BN(web3.utils.toWei("0.0002", "ether"))
      };
      const autoMarketOrderB: OrderInfo = {
        tokenS: "GTO",
        tokenB: "WETH",
        amountS: new BN(web3.utils.toWei("0.495", "ether")),
        amountB: new BN(web3.utils.toWei("0.999999", "ether")),
        owner: exchangeTestUtil.testContext.orderOwners[1],
        feeBips: 0,
        fillAmountBorS: false,
        feeTokenID: 0,
        fee: new BN("21000000000000"),
        maxFee: new BN("21000000000000"),
        uiReferID: 1,
        type: 0
      };

      const spread = new BN(web3.utils.toWei("1", "ether"));
      const ringAutoMarket: SpotTrade = {
        orderA: autoMarketOrderA,
        orderB: autoMarketOrderB,
        expected: {
          orderA: { filledFraction: 1.0, spread },
          orderB: { filledFraction: 0.5 }
        }
      };
      await exchangeTestUtil.setupRing(
        ringAutoMarket,
        true,
        true,
        false,
        false,
        256,
        513
      );
      await exchangeTestUtil.sendRing(ringAutoMarket);

      {
        const autoMarketOrderANext: OrderInfo = {
          tokenS: "GTO",
          tokenB: "WETH",
          amountS: new BN(web3.utils.toWei("0.4948", "ether")),
          amountB: new BN(web3.utils.toWei("1", "ether")),
          owner: exchangeTestUtil.testContext.orderOwners[0],
          feeBips: 18,
          fillAmountBorS: true,
          feeTokenID: 0,
          fee: new BN("12300000000000"),
          maxFee: new BN("12300000000000"),
          uiReferID: 3,
          type: 6,
          level: 0,
          startOrder: autoMarketOrderA,
          maxLevel: 10,
          gridOffset: new BN(web3.utils.toWei("0.0005", "ether")),
          orderOffset: new BN(web3.utils.toWei("0.0002", "ether")),
          isNextOrder: true,
          appointedStorageID: autoMarketOrderA.storageID
        };
        const autoMarketOrderB: OrderInfo = {
          tokenS: "WETH",
          tokenB: "GTO",
          amountS: new BN(web3.utils.toWei("1", "ether")),
          amountB: new BN(web3.utils.toWei("0.4948", "ether")),
          owner: exchangeTestUtil.testContext.orderOwners[1],
          feeBips: 0,
          fillAmountBorS: false,
          feeTokenID: 0,
          fee: new BN("21000000000000"),
          maxFee: new BN("21000000000000"),
          uiReferID: 1
        };

        const spread = new BN(web3.utils.toWei("1", "ether"));
        const ringAutoMarket: SpotTrade = {
          orderA: autoMarketOrderANext,
          orderB: autoMarketOrderB,
          expected: {
            orderA: { filledFraction: 1.0, spread },
            orderB: { filledFraction: 0.5 }
          }
        };
        await exchangeTestUtil.setupRing(
          ringAutoMarket,
          true,
          true,
          false,
          false,
          256,
          514
        );
        await exchangeTestUtil.sendRing(ringAutoMarket);
      }
      {
        const autoMarketOrderALevelOne: OrderInfo = {
          tokenS: "WETH",
          tokenB: "GTO",
          amountS: new BN(web3.utils.toWei("1", "ether")),
          amountB: new BN(web3.utils.toWei("0.4955", "ether")),
          owner: exchangeTestUtil.testContext.orderOwners[0],
          feeBips: 18,
          fillAmountBorS: false,
          feeTokenID: 0,
          fee: new BN("12300000000000"),
          maxFee: new BN("12300000000000"),
          type: 6,
          level: 1,
          startOrder: autoMarketOrderA,
          isNextOrder: false,
          maxLevel: 10,
          gridOffset: new BN(web3.utils.toWei("0.0005", "ether")),
          orderOffset: new BN(web3.utils.toWei("0.0002", "ether"))
        };
        const autoMarketOrderB: OrderInfo = {
          tokenS: "GTO",
          tokenB: "WETH",
          amountS: new BN(web3.utils.toWei("0.4955", "ether")),
          amountB: new BN(web3.utils.toWei("1", "ether")),
          owner: exchangeTestUtil.testContext.orderOwners[1],
          feeBips: 0,
          fillAmountBorS: false,
          feeTokenID: 0,
          fee: new BN("21000000000000"),
          maxFee: new BN("21000000000000"),
          uiReferID: 1
        };

        const spread = new BN(web3.utils.toWei("1", "ether"));
        const ringAutoMarket: SpotTrade = {
          orderA: autoMarketOrderALevelOne,
          orderB: autoMarketOrderB,
          expected: {
            orderA: { filledFraction: 1.0, spread },
            orderB: { filledFraction: 0.5 }
          }
        };
        await exchangeTestUtil.setupRing(
          ringAutoMarket,
          true,
          true,
          false,
          false,
          257,
          515
        );
        await exchangeTestUtil.sendRing(ringAutoMarket);
      }
      {
        const autoMarketOrderALevelOneNext: OrderInfo = {
          tokenS: "GTO",
          tokenB: "WETH",
          amountS: new BN(web3.utils.toWei("0.4953", "ether")),
          amountB: new BN(web3.utils.toWei("1", "ether")),
          owner: exchangeTestUtil.testContext.orderOwners[0],
          feeBips: 18,
          fillAmountBorS: true,
          feeTokenID: 0,
          fee: new BN("12300000000000"),
          maxFee: new BN("12300000000000"),
          type: 6,
          level: 1,
          startOrder: autoMarketOrderA,
          isNextOrder: true,
          maxLevel: 10,
          gridOffset: new BN(web3.utils.toWei("0.0005", "ether")),
          orderOffset: new BN(web3.utils.toWei("0.0002", "ether"))
        };
        const autoMarketOrderB: OrderInfo = {
          tokenS: "WETH",
          tokenB: "GTO",
          amountS: new BN(web3.utils.toWei("1", "ether")),
          amountB: new BN(web3.utils.toWei("0.4953", "ether")),
          owner: exchangeTestUtil.testContext.orderOwners[1],
          feeBips: 0,
          fillAmountBorS: false,
          feeTokenID: 0,
          fee: new BN("21000000000000"),
          maxFee: new BN("21000000000000"),
          uiReferID: 1
        };

        const spread = new BN(web3.utils.toWei("1", "ether"));
        const ringAutoMarket: SpotTrade = {
          orderA: autoMarketOrderALevelOneNext,
          orderB: autoMarketOrderB,
          expected: {
            orderA: { filledFraction: 1.0, spread },
            orderB: { filledFraction: 0.5 }
          }
        };
        await exchangeTestUtil.setupRing(
          ringAutoMarket,
          true,
          true,
          false,
          false,
          257,
          516
        );
        await exchangeTestUtil.sendRing(ringAutoMarket);
      }

      const autoMarketOrderABuy: OrderInfo = {
        tokenS: "GTO",
        tokenB: "WETH",
        amountS: new BN(web3.utils.toWei("0.305", "ether")),
        amountB: new BN(web3.utils.toWei("1", "ether")),
        owner: exchangeTestUtil.testContext.orderOwners[0],
        feeBips: 18,
        fillAmountBorS: true,
        feeTokenID: 0,
        fee: new BN("12300000000000"),
        maxFee: new BN("12300000000000"),
        type: 7,
        level: 0,
        isNextOrder: false,
        // maxLevel: 255,
        maxLevel: 10,
        gridOffset: new BN(web3.utils.toWei("0.0005", "ether")),
        orderOffset: new BN(web3.utils.toWei("0.0002", "ether"))
      };
      const autoMarketOrderBBuy: OrderInfo = {
        tokenS: "WETH",
        tokenB: "GTO",
        amountS: new BN(web3.utils.toWei("1", "ether")),
        amountB: new BN(web3.utils.toWei("0.305", "ether")),
        owner: exchangeTestUtil.testContext.orderOwners[1],
        feeBips: 0,
        fillAmountBorS: false,
        feeTokenID: 0,
        fee: new BN("21000000000000"),
        maxFee: new BN("21000000000000"),
        type: 0
      };

      const ringAutoMarketBuy: SpotTrade = {
        orderA: autoMarketOrderABuy,
        orderB: autoMarketOrderBBuy,
        expected: {
          orderA: { filledFraction: 1.0, spread },
          orderB: { filledFraction: 0.5 }
        }
      };
      await exchangeTestUtil.setupRing(
        ringAutoMarketBuy,
        true,
        true,
        false,
        false,
        258,
        517
      );
      await exchangeTestUtil.sendRing(ringAutoMarketBuy);

      {
        const autoMarketOrderABuyReverse: OrderInfo = {
          tokenS: "WETH",
          tokenB: "GTO",
          amountS: new BN(web3.utils.toWei("1", "ether")),
          amountB: new BN(web3.utils.toWei("0.3052", "ether")),
          owner: exchangeTestUtil.testContext.orderOwners[0],
          feeBips: 18,
          fillAmountBorS: false,
          feeTokenID: 0,
          fee: new BN("12300000000000"),
          maxFee: new BN("12300000000000"),
          type: 7,
          level: 0,
          isNextOrder: true,
          // maxLevel: 255,
          maxLevel: 10,
          gridOffset: new BN(web3.utils.toWei("0.0005", "ether")),
          orderOffset: new BN(web3.utils.toWei("0.0002", "ether")),
          startOrder: autoMarketOrderABuy,
          appointedStorageID: autoMarketOrderABuy.storageID
        };
        const autoMarketOrderBBuyReverse: OrderInfo = {
          tokenS: "GTO",
          tokenB: "WETH",
          amountS: new BN(web3.utils.toWei("0.3052", "ether")),
          amountB: new BN(web3.utils.toWei("1", "ether")),
          owner: exchangeTestUtil.testContext.orderOwners[1],
          feeBips: 0,
          fillAmountBorS: false,
          feeTokenID: 0,
          fee: new BN("21000000000000"),
          maxFee: new BN("21000000000000"),
          type: 0
        };

        const ringAutoMarketBuy: SpotTrade = {
          orderA: autoMarketOrderABuyReverse,
          orderB: autoMarketOrderBBuyReverse,
          expected: {
            orderA: { filledFraction: 1.0, spread },
            orderB: { filledFraction: 0.5 }
          }
        };
        await exchangeTestUtil.setupRing(
          ringAutoMarketBuy,
          true,
          true,
          false,
          false,
          258,
          518
        );
        await exchangeTestUtil.sendRing(ringAutoMarketBuy);
      }

      {
        const autoMarketOrderABuyLevel1: OrderInfo = {
          tokenS: "GTO",
          tokenB: "WETH",
          amountS: new BN(web3.utils.toWei("0.3045", "ether")),
          amountB: new BN(web3.utils.toWei("1", "ether")),
          owner: exchangeTestUtil.testContext.orderOwners[0],
          feeBips: 18,
          fillAmountBorS: true,
          feeTokenID: 0,
          fee: new BN("12300000000000"),
          maxFee: new BN("12300000000000"),
          type: 7,
          level: 1,
          isNextOrder: false,
          // maxLevel: 255,
          maxLevel: 10,
          startOrder: autoMarketOrderABuy,
          gridOffset: new BN(web3.utils.toWei("0.0005", "ether")),
          orderOffset: new BN(web3.utils.toWei("0.0002", "ether"))
        };
        const autoMarketOrderBBuy: OrderInfo = {
          tokenS: "WETH",
          tokenB: "GTO",
          amountS: new BN(web3.utils.toWei("1", "ether")),
          amountB: new BN(web3.utils.toWei("0.3045", "ether")),
          owner: exchangeTestUtil.testContext.orderOwners[1],
          feeBips: 0,
          fillAmountBorS: false,
          feeTokenID: 0,
          fee: new BN("21000000000000"),
          maxFee: new BN("21000000000000"),
          type: 0
        };

        const ringAutoMarketBuy: SpotTrade = {
          orderA: autoMarketOrderABuyLevel1,
          orderB: autoMarketOrderBBuy,
          expected: {
            orderA: { filledFraction: 1.0, spread },
            orderB: { filledFraction: 0.5 }
          }
        };
        await exchangeTestUtil.setupRing(
          ringAutoMarketBuy,
          true,
          true,
          false,
          false,
          259,
          519
        );
        await exchangeTestUtil.sendRing(ringAutoMarketBuy);
      }

      {
        const autoMarketOrderABuyReverse: OrderInfo = {
          tokenS: "WETH",
          tokenB: "GTO",
          amountS: new BN(web3.utils.toWei("1", "ether")),
          amountB: new BN(web3.utils.toWei("0.3047", "ether")),
          owner: exchangeTestUtil.testContext.orderOwners[0],
          feeBips: 18,
          fillAmountBorS: false,
          feeTokenID: 0,
          fee: new BN("12300000000000"),
          maxFee: new BN("12300000000000"),
          type: 7,
          level: 1,
          isNextOrder: false,
          startOrder: autoMarketOrderABuy,
          // maxLevel: 255,
          maxLevel: 10,
          gridOffset: new BN(web3.utils.toWei("0.0005", "ether")),
          orderOffset: new BN(web3.utils.toWei("0.0002", "ether"))
        };
        const autoMarketOrderBBuyReverse: OrderInfo = {
          tokenS: "GTO",
          tokenB: "WETH",
          amountS: new BN(web3.utils.toWei("0.3047", "ether")),
          amountB: new BN(web3.utils.toWei("1", "ether")),
          owner: exchangeTestUtil.testContext.orderOwners[1],
          feeBips: 0,
          fillAmountBorS: false,
          feeTokenID: 0,
          fee: new BN("21000000000000"),
          maxFee: new BN("21000000000000"),
          type: 0
        };

        const ringAutoMarketBuy: SpotTrade = {
          orderA: autoMarketOrderABuyReverse,
          orderB: autoMarketOrderBBuyReverse,
          expected: {
            orderA: { filledFraction: 1.0, spread },
            orderB: { filledFraction: 0.5 }
          }
        };
        await exchangeTestUtil.setupRing(
          ringAutoMarketBuy,
          true,
          true,
          false,
          false,
          259,
          520
        );
        await exchangeTestUtil.sendRing(ringAutoMarketBuy);
      }

      await exchangeTestUtil.submitTransactions(28, true);
      // // // Submit the block
      // await exchangeTestUtil.submitPendingBlocks();
    });

  });
});