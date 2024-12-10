import {
  SigningCosmWasmClient,
  CosmWasmClient,
} from "@cosmjs/cosmwasm-stargate";
import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import { GasPrice, calculateFee, Coin } from "@cosmjs/stargate";
import { ServiceManager } from "../common/ServiceManager.js";
import { FaucetProcess, FaucetLogLevel } from "../common/FaucetProcess.js";
import { FaucetStatus, FaucetStatusLevel } from "../services/FaucetStatus.js";
import { WalletState, TransactionResult, FaucetConfig } from "./interfaces.js";
import { faucetConfig } from "../config/FaucetConfig.js";

export class CwWalletManager {
  private initialized: boolean = false;
  private signingClient: SigningCosmWasmClient;
  private queryClient: CosmWasmClient;
  private wallet: DirectSecp256k1HdWallet;
  private walletAddress: string;
  private walletState: WalletState;
  private lastWalletRefresh: number;

  public async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    this.walletState = {
      ready: false,
      sequence: 0,
      balance: 0n,
      nativeBalance: 0n,
    };

    await this.startClient();

    ServiceManager.GetService(FaucetProcess).addListener("reload", () => {
      this.startClient();
      this.lastWalletRefresh = 0;
    });
  }

  private async startClient(): Promise<void> {
    try {
      // Initialize wallet from mnemonic


      this.wallet = await DirectSecp256k1HdWallet.fromMnemonic(
        faucetConfig.cwWalletMnemonic,
        { prefix: faucetConfig.cwAddressPrefix }
      );


      // Get wallet address
      const [account] = await this.wallet.getAccounts();
   
      this.walletAddress = account.address;

      // Initialize signing client
      this.signingClient = await SigningCosmWasmClient.connectWithSigner(
        faucetConfig.cwRpcHost,
        this.wallet,
        {
          gasPrice: GasPrice.fromString(faucetConfig.cwGasPrice),
        }
      );


      // Initialize query client for read operations
      this.queryClient = await CosmWasmClient.connect(faucetConfig.cwRpcHost);

      await this.loadWalletState();
    } catch (err) {

      ServiceManager.GetService(FaucetProcess).emitLog(
        FaucetLogLevel.ERROR,
        `Failed to initialize wallet: ${err.toString()}`
      );

      setTimeout(() => this.startClient(), 5000);
    }
  }

  public getWalletState(): WalletState {
    return this.walletState;
  }

  public getLastWalletRefresh(): number {
    return this.lastWalletRefresh;
  }

  public getFaucetAddress(): string {
    return this.walletAddress;
  }
  public getFaucetBalance(): bigint {
    return this.walletState.balance;
  }

  public getFaucetDecimals(): number {
    return faucetConfig.cwDecimals;
  }

  public async loadWalletState(): Promise<void> {
    this.lastWalletRefresh = Math.floor(new Date().getTime() / 1000);

    try {
      // Get account sequence
      const account = await this.signingClient.getAccount(this.walletAddress);

      let balance: bigint;
      if (faucetConfig.cwIsNativeToken) {
        const nativeBalance = await this.signingClient.getBalance(
          this.walletAddress,
          faucetConfig.cwDenom
        );
        balance = BigInt(nativeBalance.amount);
      } else {
        // Query contract token balance
        const balanceResponse = await this.queryClient.queryContractSmart(
          faucetConfig.cwContractAddress,
          {
            balance: { address: this.walletAddress },
          }
        );
        balance = BigInt(balanceResponse.balance);
      }

      // Get native balance for gas
      const nativeBalance = await this.signingClient.getBalance(
        this.walletAddress,
        faucetConfig.cwDenom
      );

      this.walletState = {
        ready: true,
        sequence: account?.sequence || 0,
        balance: balance,
        nativeBalance: BigInt(nativeBalance.amount),
      };

      ServiceManager.GetService(FaucetProcess).emitLog(
        FaucetLogLevel.INFO,
        `Wallet ${this.walletAddress}: ${this.readableAmount(
          balance
        )} [Sequence: ${account?.sequence || 0}]`
      );

      this.updateFaucetStatus();
    } catch (err) {
      this.walletState = {
        ready: false,
        sequence: 0,
        balance: 0n,
        nativeBalance: 0n,
      };

      ServiceManager.GetService(FaucetProcess).emitLog(
        FaucetLogLevel.ERROR,
        `Error loading wallet state: ${err.toString()}`
      );

      this.updateFaucetStatus();
    }
  }

  private updateFaucetStatus(): void {
    let statusMessage: string | null = null;
    let statusLevel: FaucetStatusLevel | null = null;

    if (!this.walletState.ready) {
      statusMessage = "Cannot connect to network";
      statusLevel = FaucetStatusLevel.ERROR;
    } else if (
      this.walletState.balance <= BigInt(faucetConfig.cwMinBalance) ||
      this.walletState.nativeBalance <= BigInt(faucetConfig.cwMinGasAmount)
    ) {

      console.log("this.walletState.balance", this.walletState.balance);
      statusMessage = "The faucet is out of funds!";
      statusLevel = FaucetStatusLevel.ERROR;
    } else if (
      this.walletState.balance <= BigInt(faucetConfig.cwLowBalanceThreshold)
    ) {
      statusMessage = `The faucet is running low on funds! Balance: ${this.readableAmount(
        this.walletState.balance
      )}`;
      statusLevel = FaucetStatusLevel.WARNING;
    }

    ServiceManager.GetService(FaucetStatus).setFaucetStatus(
      "wallet",
      statusMessage ?? "",
      statusLevel ?? FaucetStatusLevel.INFO
    );
  }

  public readableAmount(amount: bigint): string {
    const amountStr = (
      Math.floor(
        (Number(amount) / Math.pow(10, faucetConfig.cwDecimals)) * 1000
      ) / 1000
    ).toString();

    return `${amountStr} ${faucetConfig.cwSymbol}`;
  }

  public async getWalletBalance(addr: string): Promise<bigint> {
    if (faucetConfig.cwIsNativeToken) {
      const balance = await this.signingClient.getBalance(
        addr,
        faucetConfig.cwDenom
      );
      return BigInt(balance.amount);
    } else {
      const response = await this.queryClient.queryContractSmart(
        faucetConfig.cwContractAddress,
        {
          balance: { address: addr },
        }
      );
      return BigInt(response.balance);
    }
  }

  public async executeContract(
    contractAddr: string,
    msg: any,
    fee: { amount: { denom: string; amount: string }[]; gas: string }
  ): Promise<TransactionResult> {
    if (!this.walletState.ready) {
      throw new Error("Wallet not ready");
    }
  
    try {
      const tx = await this.signingClient.execute(
        this.walletAddress,
        contractAddr,
        msg,
        fee
      );
  
      // Update wallet state
      this.walletState.sequence++;
      this.walletState.nativeBalance -= BigInt(fee.amount[0].amount);
  
      return {
        txHash: tx.transactionHash,
        txPromise: Promise.resolve({
          status: true,
          height: tx.height,
          fee: BigInt(fee.amount[0].amount),
          gasUsed: Number(tx.gasUsed),
        }),
      };
    } catch (err) {
      throw new Error(`Failed to execute contract: ${err.toString()}`);
    }
  }

  public async sendTokens(
    recipientAddr: string,
    amount: string
  ): Promise<TransactionResult> {
    if (!this.walletState.ready) {
      throw new Error("Wallet not ready");
    }

    try {
      let tx;
      if (faucetConfig.cwIsNativeToken) {
        // Send native tokens
        tx = await this.signingClient.sendTokens(
          this.walletAddress,
          recipientAddr,
          [{ denom: faucetConfig.cwDenom, amount }],
          {
            amount: [
              { denom: faucetConfig.cwDenom, amount: faucetConfig.cwGasAmount },
            ],
            gas: faucetConfig.cwGasLimit,
          }
        );
      } else {
        // Send contract tokens
        const msg = {
          transfer: {
            recipient: recipientAddr,
            amount: amount,
          },
        };

        tx = await this.signingClient.execute(
          this.walletAddress,
          faucetConfig.cwContractAddress,
          msg,
          {
            amount: [
              { denom: faucetConfig.cwDenom, amount: faucetConfig.cwGasAmount },
            ],
            gas: faucetConfig.cwGasLimit,
          }
        );
      }

      // Update wallet state
      this.walletState.sequence++;
      this.walletState.balance -= BigInt(amount);

      if (faucetConfig.cwIsNativeToken) {
        this.walletState.nativeBalance -=
          BigInt(amount) + BigInt(faucetConfig.cwGasAmount);
      } else {
        this.walletState.nativeBalance -= BigInt(faucetConfig.cwGasAmount);
      }

      return {
        txHash: tx.transactionHash,
        txPromise: Promise.resolve({
          status: true,
          height: tx.height,
          fee: BigInt(faucetConfig.cwGasAmount),
          gasUsed: Number(tx.gasUsed),
        }),
      };
    } catch (err) {
      throw new Error(`Failed to send tokens: ${err.toString()}`);
    }
  }

  public getQueryClient(): CosmWasmClient {
    return this.queryClient;
  }

  public getSigningClient(): SigningCosmWasmClient {
    return this.signingClient;
  }
}
