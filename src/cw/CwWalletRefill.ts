import { ServiceManager } from "../common/ServiceManager.js";
import { FaucetProcess, FaucetLogLevel } from "../common/FaucetProcess.js";
import { CwWalletManager } from "./CwWalletManager.js";
import { SessionManager } from "../session/SessionManager.js";
import { faucetConfig } from "../config/FaucetConfig.js";
import { CwClaimManager } from "./CwClaimManager.js";
import { RefillState } from "./interfaces.js";

export class CwWalletRefill {
  private lastRefillTime: number = 0;
  private lastRefillTry: number = 0;
  private refillPromise: Promise<void> | null = null;
  private isRefilling: boolean = false;

  private now(): number {
    return Math.floor(new Date().getTime() / 1000);
  }

  public processWalletRefill(): Promise<void> {
    if (!this.refillPromise) {
      this.refillPromise = this.tryRefillWallet().finally(() => {
        this.refillPromise = null;
      });
    }
    return this.refillPromise;
  }

  private async tryRefillWallet(): Promise<void> {
    if (!faucetConfig.cwRefillEnabled || !faucetConfig.cwRefillContract) {
      return;
    }

    const now = this.now();
    
    // Check cooldown periods
    if (
      this.lastRefillTry && 
      now - this.lastRefillTry < 60
    ) {
      return;
    }
    
    if (
      this.lastRefillTime && 
      faucetConfig.cwRefillCooldown && 
      now - this.lastRefillTime < faucetConfig.cwRefillCooldown
    ) {
      return;
    }

    this.lastRefillTry = now;

    try {
      const walletManager = ServiceManager.GetService(CwWalletManager);
      const walletState = walletManager.getWalletState();

      if (!walletState.ready) {
        throw new Error("Wallet not ready");
      }

      // Calculate available balance
      const unclaimedBalance = await ServiceManager.GetService(
        SessionManager
      ).getUnclaimedBalance();
      
      const queuedAmount = ServiceManager.GetService(
        CwClaimManager
      ).getQueuedAmount();

      const availableBalance = walletState.balance - unclaimedBalance - queuedAmount;

      // Check if refill is needed
      let refillAction: "refill" | "overflow" | null = null;

      if (
        faucetConfig.cwRefillOverflowAmount && 
        availableBalance > BigInt(faucetConfig.cwRefillOverflowAmount)
      ) {
        refillAction = "overflow";
      } else if (availableBalance < BigInt(faucetConfig.cwRefillThreshold)) {
        refillAction = "refill";
      }

      if (!refillAction) {
        return;
      }

      this.isRefilling = true;

      try {
        let txResult;
        if (refillAction === "refill") {
          txResult = await this.executeRefill();
        } else {
          const overflowAmount = availableBalance - BigInt(faucetConfig.cwRefillOverflowAmount);
          txResult = await this.executeOverflow(overflowAmount.toString());
        }

        if (!txResult?.txHash) {
          throw new Error("No transaction hash returned");
        }

        this.lastRefillTime = this.now();

        ServiceManager.GetService(FaucetProcess).emitLog(
          FaucetLogLevel.INFO,
          `Sending ${refillAction} transaction to contract: ${txResult.txHash}`
        );

        const txReceipt = await txResult.txPromise;
        if (!txReceipt.status) {
          throw new Error("Transaction failed");
        }

        // Refresh wallet state after successful refill
        await ServiceManager.GetService(CwWalletManager).loadWalletState();

        ServiceManager.GetService(FaucetProcess).emitLog(
          FaucetLogLevel.INFO,
          `Faucet wallet successfully ${refillAction}ed with contract.`
        );
      } catch (err) {
        ServiceManager.GetService(FaucetProcess).emitLog(
          FaucetLogLevel.WARNING,
          `Faucet wallet ${refillAction} transaction failed: ${err.toString()}`
        );
        throw err;
      }
    } catch (ex) {
      ServiceManager.GetService(FaucetProcess).emitLog(
        FaucetLogLevel.WARNING,
        `Faucet wallet refill attempt failed: ${ex.toString()}`
      );
    } finally {
      this.isRefilling = false;
    }
  }

  private async executeRefill() {
    const walletManager = ServiceManager.GetService(CwWalletManager);
    
    if (!faucetConfig.cwRefillContract || !faucetConfig.cwRefillAmount) {
      throw new Error("Refill configuration missing");
    }

    const msg = {
      withdraw: {
        amount: faucetConfig.cwRefillAmount
      }
    };

    return await walletManager.executeContract(
      faucetConfig.cwRefillContract,
      msg,
      {
        amount: [{ 
          denom: faucetConfig.cwDenom, 
          amount: faucetConfig.cwGasAmount 
        }],
        gas: faucetConfig.cwGasLimit,
      }
    );
  }

  private async executeOverflow(amount: string) {
    const walletManager = ServiceManager.GetService(CwWalletManager);
    
    if (!faucetConfig.cwRefillContract) {
      throw new Error("Refill configuration missing");
    }

    const msg = {
      deposit: {}
    };

    return await walletManager.executeContract(
      faucetConfig.cwRefillContract,
      msg,
      {
        amount: [{
          denom: faucetConfig.cwDenom,
          amount: amount
        }],
        gas: faucetConfig.cwGasLimit,
      }
    );
  }

  public getRefillState(): RefillState {
    const now = this.now();
    let cooldownRemaining = 0;

    if (
      this.lastRefillTime && 
      faucetConfig.cwRefillCooldown
    ) {
      const elapsed = now - this.lastRefillTime;
      if (elapsed < faucetConfig.cwRefillCooldown) {
        cooldownRemaining = faucetConfig.cwRefillCooldown - elapsed;
      }
    }

    return {
      lastRefillTime: this.lastRefillTime,
      isRefilling: this.isRefilling,
      cooldownRemaining
    };
  }
}