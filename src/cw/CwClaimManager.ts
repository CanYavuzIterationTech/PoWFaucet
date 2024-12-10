import { WebSocket } from "ws";
import { IncomingMessage } from "http";
import { ServiceManager } from "../common/ServiceManager.js";
import { FaucetProcess, FaucetLogLevel } from "../common/FaucetProcess.js";
import { FaucetDatabase } from "../db/FaucetDatabase.js";
import { FaucetHttpServer } from "../webserv/FaucetHttpServer.js";
import { ModuleHookAction, ModuleManager } from "../modules/ModuleManager.js";
import { FaucetOutflowModule } from "../modules/faucet-outflow/FaucetOutflowModule.js";
import { FaucetStatsLog } from "../services/FaucetStatsLog.js";
import { CwWalletManager } from "./CwWalletManager.js";
import { CwClaimNotificationClient } from "./CwClaimNotificationClient.js";
import { FaucetError } from "../common/FaucetError.js";
import {
  FaucetSessionStatus,
  FaucetSessionStoreData,
} from "../session/FaucetSession.js";
import { faucetConfig } from "../config/FaucetConfig.js";
import {
  ClaimTxStatus,
  ClaimInfo,
  ClaimData,
  IClaimNotificationData,
} from "./interfaces.js";

export class CwClaimManager {
  private initialized: boolean = false;
  private queueInterval: NodeJS.Timeout;
  private claimTxDict: { [session: string]: ClaimInfo } = {};
  private claimTxQueue: ClaimInfo[] = [];
  private pendingTxQueue: { [hash: string]: ClaimInfo } = {};
  private historyTxDict: { [sequence: number]: ClaimInfo } = {};
  private queueProcessing: boolean = false;
  private lastClaimTxIdx: number = 1;
  private lastProcessedClaimTxIdx: number = 0;
  private lastConfirmedClaimTxIdx: number = 0;
  private lastNotificationData: IClaimNotificationData | null = null;

  public async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    // Restore saved claimTx queue
    let maxQueueIdx = 0;
    const storedSession = await ServiceManager.GetService(
      FaucetDatabase
    ).getSessions([FaucetSessionStatus.CLAIMING]);

    storedSession.forEach((sessionData) => {
      const claimInfo: ClaimInfo = {
        session: sessionData.sessionId,
        target: sessionData.targetAddr,
        amount: sessionData.dropAmount,
        claim: sessionData.claim!,
      };

      switch (claimInfo.claim.claimStatus) {
        case ClaimTxStatus.QUEUE:
        case ClaimTxStatus.PROCESSING:
          this.claimTxQueue.push(claimInfo);
          this.claimTxDict[claimInfo.session] = claimInfo;
          break;
        case ClaimTxStatus.PENDING:
          if (claimInfo.claim.txHash) {
            this.pendingTxQueue[claimInfo.claim.txHash] = claimInfo;
          }
          this.claimTxDict[claimInfo.session] = claimInfo;
          this.awaitTxConfirmation(claimInfo);
          break;
        default:
          ServiceManager.GetService(FaucetProcess).emitLog(
            FaucetLogLevel.ERROR,
            `Cannot restore claimTx: unexpected claim status '${claimInfo.claim.claimStatus}'`
          );
          return;
      }

      if (claimInfo.claim.claimIdx > maxQueueIdx) {
        maxQueueIdx = claimInfo.claim.claimIdx;
      }
    });

    this.claimTxQueue.sort((a, b) => a.claim.claimIdx - b.claim.claimIdx);
    this.lastClaimTxIdx = maxQueueIdx + 1;

    // Register claim ws endpoint
    ServiceManager.GetService(FaucetHttpServer).addWssEndpoint(
      "claim",
      /^\/ws\/claim($|\?)/,
      (req, ws, ip) => this.processClaimNotificationWebSocket(req, ws, ip)
    );

    // Start queue processing interval
    this.queueInterval = setInterval(() => this.processQueue(), 2000);
  }

  public dispose() {
    if (!this.initialized) return;
    this.initialized = false;

    CwClaimNotificationClient.resetClaimNotification();
    clearInterval(this.queueInterval);
  }

  private async processClaimNotificationWebSocket(
    req: IncomingMessage,
    ws: WebSocket,
    remoteIp: string
  ) {
    let sessionId: string;
    try {
      if (!req.url) {
        ws.send(
          JSON.stringify({
            action: "error",
            data: { reason: "Invalid request URL" },
          })
        );
        ws.close();
        return;
      }
      const urlParts = req.url.split("?");
      const url = new URLSearchParams(urlParts[1]);
      sessionId = url.get("session") || "";
      if (!sessionId) {
        throw "session not found";
      }

      const sessionInfo = await ServiceManager.GetService(
        FaucetDatabase
      ).getSession(sessionId);
      if (!sessionId || !sessionInfo) {
        throw "session not found";
      }

      if (sessionInfo.status !== FaucetSessionStatus.CLAIMING) {
        throw "session not claiming";
      }

      if (sessionInfo.claim) {
        new CwClaimNotificationClient(ws, sessionInfo.claim.claimIdx);
      } else {
        throw "claim not found";
      }
    } catch (ex) {
      ws.send(
        JSON.stringify({
          action: "error",
          data: { reason: ex.toString() },
        })
      );
      ws.close();
    }
  }

  public getTransactionQueue(queueOnly?: boolean): ClaimInfo[] {
    const txlist: ClaimInfo[] = [];
    Array.prototype.push.apply(txlist, this.claimTxQueue);
    if (!queueOnly) {
      Array.prototype.push.apply(txlist, Object.values(this.pendingTxQueue));
      Array.prototype.push.apply(txlist, Object.values(this.historyTxDict));
    }
    return txlist;
  }

  public getQueuedAmount(): bigint {
    let totalPending = 0n;
    this.claimTxQueue.forEach((claimTx) => {
      totalPending += BigInt(claimTx.amount);
    });
    return totalPending;
  }

  public getLastProcessedClaimIdx(): number {
    return this.lastProcessedClaimTxIdx;
  }

  private updateClaimStatus(claimInfo: ClaimInfo) {
    if (claimInfo.claim.claimStatus === ClaimTxStatus.CONFIRMED) {
      const moduleManager = ServiceManager.GetService(ModuleManager);
      moduleManager.processActionHooks([], ModuleHookAction.SessionClaimed, [
        claimInfo,
      ]);
      moduleManager
        .getModule<FaucetOutflowModule>("faucet-outflow")
        ?.updateState(null, BigInt(claimInfo.claim.txFee || 0));
      ServiceManager.GetService(FaucetStatsLog).addClaimStats(claimInfo);
    }
    ServiceManager.GetService(FaucetDatabase).updateClaimData(
      claimInfo.session,
      claimInfo.claim
    );
  }

  public async createSessionClaim(
    sessionData: FaucetSessionStoreData,
    userInput: any
  ): Promise<ClaimInfo> {
    if (sessionData.status !== FaucetSessionStatus.CLAIMABLE) {
      throw new FaucetError(
        "NOT_CLAIMABLE",
        `Cannot claim session: not claimable (state: ${sessionData.status})`
      );
    }

    if (BigInt(sessionData.dropAmount) < BigInt(faucetConfig.cwMinAmount)) {
      throw new FaucetError("AMOUNT_TOO_LOW", "Drop amount lower than minimum");
    }

    if (BigInt(sessionData.dropAmount) > BigInt(faucetConfig.cwMaxAmount)) {
      throw new FaucetError(
        "AMOUNT_TOO_HIGH",
        "Drop amount higher than maximum"
      );
    }

    if (!sessionData.targetAddr.startsWith(faucetConfig.cwAddressPrefix)) {
      throw new FaucetError("INVALID_ADDRESS", "Invalid address format");
    }

    // Prevent multi claim via race condition
    if (this.claimTxDict[sessionData.sessionId]) {
      throw new FaucetError(
        "RACE_CLAIMING",
        "Cannot claim session: already claiming (race condition)"
      );
    }

    const claimInfo: ClaimInfo = {
      session: sessionData.sessionId,
      target: sessionData.targetAddr,
      amount: sessionData.dropAmount,
      claim: {
        claimIdx: this.lastClaimTxIdx++,
        claimStatus: ClaimTxStatus.QUEUE,
        claimTime: Math.floor(new Date().getTime() / 1000),
      },
    };

    try {
      await ServiceManager.GetService(ModuleManager).processActionHooks(
        [],
        ModuleHookAction.SessionClaim,
        [claimInfo, userInput]
      );
    } catch (ex) {
      if (ex instanceof FaucetError) throw ex;
      else
        throw new FaucetError(
          "INTERNAL_ERROR",
          `claimSession failed: ${ex.toString()}`
        );
    }

    sessionData.status = FaucetSessionStatus.CLAIMING;
    sessionData.dropAmount = claimInfo.amount;
    sessionData.claim = claimInfo.claim;
    await ServiceManager.GetService(FaucetDatabase).updateSession(sessionData);

    this.claimTxQueue.push(claimInfo);
    this.claimTxDict[claimInfo.session] = claimInfo;
    return claimInfo;
  }

  private async processQueue() {
    if (this.queueProcessing) return;
    this.queueProcessing = true;

    try {
      const walletManager = ServiceManager.GetService(CwWalletManager);
      const walletState = walletManager.getWalletState();

      while (
        Object.keys(this.pendingTxQueue).length < faucetConfig.cwMaxPending &&
        this.claimTxQueue.length > 0
      ) {
        if (
          !walletState.ready ||
          walletState.nativeBalance <= BigInt(faucetConfig.cwMinGasAmount)
        ) {
          break; // Skip processing (out of funds for gas)
        }

        const claimTx = this.claimTxQueue.splice(0, 1)[0];
        this.lastProcessedClaimTxIdx = claimTx.claim.claimIdx;
        await this.processQueueTx(claimTx);
      }

      if (
        !this.lastNotificationData ||
        this.lastNotificationData.processedIdx !==
          this.lastProcessedClaimTxIdx ||
        this.lastNotificationData.confirmedIdx !== this.lastConfirmedClaimTxIdx
      ) {
        const notificationData: IClaimNotificationData = {
          processedIdx: this.lastProcessedClaimTxIdx,
          confirmedIdx: this.lastConfirmedClaimTxIdx,
        };
        CwClaimNotificationClient.broadcastClaimNotification(notificationData);
      }
    } catch (ex) {
      ServiceManager.GetService(FaucetProcess).emitLog(
        FaucetLogLevel.ERROR,
        `Exception in transaction queue processing: ${ex.toString()}`
      );
    }
    this.queueProcessing = false;
  }

  private async processQueueTx(claimTx: ClaimInfo) {
    const walletManager = ServiceManager.GetService(CwWalletManager);
    const walletState = walletManager.getWalletState();

    if (!walletState.ready) {
      claimTx.claim.claimStatus = ClaimTxStatus.FAILED;
      claimTx.claim.txError = "Network RPC is currently unreachable.";
      this.updateClaimStatus(claimTx);
      return;
    }

    if (walletState.nativeBalance <= BigInt(faucetConfig.cwMinGasAmount)) {
      claimTx.claim.claimStatus = ClaimTxStatus.FAILED;
      claimTx.claim.txError = "Faucet wallet is out of gas funds.";
      this.updateClaimStatus(claimTx);
      return;
    }

    try {
      claimTx.claim.claimStatus = ClaimTxStatus.PROCESSING;

      // Send transaction
      const { txHash, txPromise } = await walletManager.sendTokens(
        claimTx.target,
        claimTx.amount
      );

      claimTx.claim.txHash = txHash;
      this.pendingTxQueue[txHash] = claimTx;

      ServiceManager.GetService(FaucetProcess).emitLog(
        FaucetLogLevel.INFO,
        `Submitted claim transaction ${
          claimTx.session
        } [${walletManager.readableAmount(BigInt(claimTx.amount))}] to: ${
          claimTx.target
        }: ${txHash}`
      );

      claimTx.claim.claimStatus = ClaimTxStatus.PENDING;
      this.updateClaimStatus(claimTx);

      this.awaitTxConfirmation(claimTx);
    } catch (ex) {
      claimTx.claim.claimStatus = ClaimTxStatus.FAILED;
      claimTx.claim.txError = `Processing Exception: ${ex.toString()}`;
      this.updateClaimStatus(claimTx);
    }
  }

  private async awaitTxConfirmation(claimTx: ClaimInfo) {
    try {
      const walletManager = ServiceManager.GetService(CwWalletManager);
      const client = walletManager.getQueryClient();
      if (!claimTx.claim.txHash) {
        throw new Error("Transaction hash is undefined");
      }
      const tx = await client.getTx(claimTx.claim.txHash);

      if (!tx || tx.code !== 0) {
        throw new Error("Transaction failed");
      }

      const txHash = claimTx.claim.txHash;
      if (txHash) {
        delete this.pendingTxQueue[txHash];
      }
      delete this.claimTxDict[claimTx.session];

      claimTx.claim.txHeight = tx.height;
      claimTx.claim.txFee = faucetConfig.cwGasAmount;
      this.lastConfirmedClaimTxIdx = claimTx.claim.claimIdx;
      claimTx.claim.claimStatus = ClaimTxStatus.CONFIRMED;

      this.updateClaimStatus(claimTx);
    } catch (error) {
      ServiceManager.GetService(FaucetProcess).emitLog(
        FaucetLogLevel.WARNING,
        `Transaction for ${claimTx.target} failed: ${error.toString()}`
      );

      if (claimTx.claim.txHash) {
        delete this.pendingTxQueue[claimTx.claim.txHash];
      }
      delete this.claimTxDict[claimTx.session];

      claimTx.claim.claimStatus = ClaimTxStatus.FAILED;
      claimTx.claim.txError = `Transaction Error: ${error.toString()}`;
      this.updateClaimStatus(claimTx);
    } finally {
      // Keep track in history for a while
      const sequence =
        ServiceManager.GetService(CwWalletManager).getWalletState().sequence;
      this.historyTxDict[sequence] = claimTx;

      setTimeout(() => {
        delete this.historyTxDict[sequence];
      }, 30 * 60 * 1000); // Keep for 30 minutes
    }
  }
}
