import { IncomingMessage } from "http";
import { faucetConfig } from "../config/FaucetConfig.js";
import { ServiceManager } from "../common/ServiceManager.js";
import { EthWalletManager } from "../eth/EthWalletManager.js";
import { CwWalletManager } from "../cw/CwWalletManager.js";
import { FaucetStatus, IFaucetStatus } from "../services/FaucetStatus.js";
import { FaucetHttpResponse } from "./FaucetHttpServer.js";
import { SessionManager } from "../session/SessionManager.js";
import {
  FaucetSession,
  FaucetSessionStatus,
  FaucetSessionStoreData,
  FaucetSessionTask,
  IClientSessionInfo,
} from "../session/FaucetSession.js";
import { ModuleHookAction, ModuleManager } from "../modules/ModuleManager.js";
import { IFaucetResultSharingConfig } from "../config/ConfigShared.js";
import { FaucetError } from "../common/FaucetError.js";
import { EthClaimInfo, EthClaimManager } from "../eth/EthClaimManager.js";
import { CwClaimManager } from "../cw/CwClaimManager.js";
import {
  buildFaucetStatus,
  buildQueueStatus,
  buildSessionStatus,
} from "./api/faucetStatus.js";
import { sha256 } from "../utils/CryptoUtils.js";

export interface IFaucetApiUrl {
  path: string[];
  query: { [key: string]: string | boolean };
}

export interface IClientFaucetConfig {
  faucetTitle: string;
  faucetStatus: IFaucetStatus[];
  faucetStatusHash: string;
  faucetImage: string;
  faucetHtml: string;
  faucetCoinSymbol: string;
  faucetCoinType: string;
  faucetCoinContract: string;
  faucetCoinDecimals: number;
  minClaim: number;
  maxClaim: number;
  sessionTimeout: number;
  ethTxExplorerLink: string;
  time: number;
  resultSharing: IFaucetResultSharingConfig;
  modules: {
    [module: string]: any;
  };
}

export interface IClientSessionStatus {
  session: string;
  status: string;
  start: number;
  tasks: FaucetSessionTask[];
  balance: string;
  target: string;
  claimIdx?: number;
  claimStatus?: string;
  claimBlock?: number;
  claimHash?: string;
  claimMessage?: string;
  failedCode?: string;
  failedReason?: string;
  details?: {
    data: any;
    claim: any;
  };
}

export const FAUCETSTATUS_CACHE_TIME = 10;

export class FaucetWebApi {
  private apiEndpoints: {
    [endpoint: string]: (
      req: IncomingMessage,
      url: IFaucetApiUrl,
      body: Buffer
    ) => Promise<any>;
  } = {};
  private cachedStatusData: {
    [key: string]: {
      time: number;
      data: any;
    };
  } = {};

  public async onApiRequest(req: IncomingMessage, body?: Buffer): Promise<any> {
    let apiUrl = this.parseApiUrl(req.url);
    if (!apiUrl || apiUrl.path.length === 0)
      return new FaucetHttpResponse(404, "Not Found");
    switch (apiUrl.path[0].toLowerCase()) {
      case "getVersion".toLowerCase():
        return this.onGetVersion();
      case "getMaxReward".toLowerCase():
        return this.onGetMaxReward();
      case "getFaucetConfig".toLowerCase():
        return this.onGetFaucetConfig(
          apiUrl.query["cliver"] as string,
          apiUrl.query["session"] as string
        );
      case "startSession".toLowerCase():
        return this.onStartSession(req, body);
      case "getSession".toLowerCase():
        return this.onGetSession(apiUrl.query["session"] as string);
      case "claimReward".toLowerCase():
        return this.onClaimReward(req, body);
      case "getSessionStatus".toLowerCase():
        return this.onGetSessionStatus(
          apiUrl.query["session"] as string,
          !!apiUrl.query["details"]
        );
      case "getQueueStatus".toLowerCase():
        return this.onGetQueueStatus();
      case "getFaucetStatus".toLowerCase():
        return this.onGetFaucetStatus(apiUrl.query["key"] as string);
      default:
        let handler: (
          req: IncomingMessage,
          url: IFaucetApiUrl,
          body: Buffer
        ) => Promise<any>;
        if ((handler = this.apiEndpoints[apiUrl.path[0].toLowerCase()]))
          return handler(req, apiUrl, body);
    }
    return new FaucetHttpResponse(404, "Not Found");
  }

  public registerApiEndpoint(
    endpoint: string,
    handler: (
      req: IncomingMessage,
      url: IFaucetApiUrl,
      body: Buffer
    ) => Promise<any>
  ) {
    this.apiEndpoints[endpoint.toLowerCase()] = handler;
  }

  public removeApiEndpoint(endpoint: string) {
    delete this.apiEndpoints[endpoint.toLowerCase()];
  }

  private parseApiUrl(url: string): IFaucetApiUrl {
    let urlMatch = /\/api\/([^?]+)(?:\?(.*))?/.exec(url);
    if (!urlMatch) return null;
    let urlRes: IFaucetApiUrl = {
      path: urlMatch[1] && urlMatch[1].length > 0 ? urlMatch[1].split("/") : [],
      query: {},
    };
    if (urlMatch[2] && urlMatch[2].length > 0) {
      urlMatch[2].split("&").forEach((query) => {
        let parts = query.split("=", 2);
        urlRes.query[parts[0]] = parts.length == 1 ? true : parts[1];
      });
    }
    return urlRes;
  }

  public getRemoteAddr(req: IncomingMessage): string {
    let remoteAddr: string = null;
    if (faucetConfig.httpProxyCount > 0 && req.headers["x-forwarded-for"]) {
      let proxyChain = (req.headers["x-forwarded-for"] as string).split(", ");
      let clientIpIdx = proxyChain.length - faucetConfig.httpProxyCount;
      if (clientIpIdx < 0) clientIpIdx = 0;
      remoteAddr = proxyChain[clientIpIdx];
    }
    if (!remoteAddr) remoteAddr = req.socket.remoteAddress;
    return remoteAddr;
  }

  private onGetVersion(): string {
    return faucetConfig.faucetVersion;
  }

  private onGetMaxReward(): number {
    return faucetConfig.maxDropAmount;
  }

  public getFaucetHomeHtml(): string {
    const network = faucetConfig.faucetNetworkType;

    let walletManager =
      network === "evm"
        ? ServiceManager.GetService(EthWalletManager)
        : ServiceManager.GetService(CwWalletManager);
    let faucetHtml = faucetConfig.faucetHomeHtml || "";
    faucetHtml = faucetHtml.replace(/{faucetWallet}/, () => {
      return walletManager.getFaucetAddress();
    });
    return faucetHtml;
  }

  public onGetFaucetConfig(
    clientVersion?: string,
    sessionId?: string
  ): IClientFaucetConfig {
    let faucetSession = sessionId
      ? ServiceManager.GetService(SessionManager).getSession(sessionId, [
          FaucetSessionStatus.RUNNING,
          FaucetSessionStatus.CLAIMABLE,
        ])
      : null;
    let faucetStatus = ServiceManager.GetService(FaucetStatus).getFaucetStatus(
      clientVersion,
      faucetSession
    );

    const network = faucetConfig.faucetNetworkType;
    let walletManager =
      network === "evm"
        ? ServiceManager.GetService(EthWalletManager)
        : ServiceManager.GetService(CwWalletManager);

    let moduleConfig = {};
    ServiceManager.GetService(ModuleManager).processActionHooks(
      [],
      ModuleHookAction.ClientConfig,
      [moduleConfig, sessionId]
    );

    return {
      faucetTitle: faucetConfig.faucetTitle,
      faucetStatus: faucetStatus.status,
      faucetStatusHash: faucetStatus.hash,
      faucetImage: faucetConfig.faucetImage,
      faucetHtml: this.getFaucetHomeHtml(),
      faucetCoinSymbol: faucetConfig.faucetCoinSymbol,
      faucetCoinType: faucetConfig.faucetCoinType,
      faucetCoinContract: faucetConfig.faucetCoinContract,
      faucetCoinDecimals: walletManager.getFaucetDecimals(),
      minClaim: faucetConfig.minDropAmount,
      maxClaim: faucetConfig.maxDropAmount,
      sessionTimeout: faucetConfig.sessionTimeout,
      ethTxExplorerLink: faucetConfig.ethTxExplorerLink,
      time: Math.floor(new Date().getTime() / 1000),
      resultSharing: faucetConfig.resultSharing,
      modules: moduleConfig,
    };
  }

  public async onStartSession(
    req: IncomingMessage,
    body: Buffer
  ): Promise<any> {
    if (req.method !== "POST")
      return new FaucetHttpResponse(405, "Method Not Allowed");

    let userInput = JSON.parse(body.toString("utf8"));
    let responseData: any = {};
    let sessionInfo: IClientSessionInfo;
    let session: FaucetSession;
    try {
      session = await ServiceManager.GetService(SessionManager).createSession(
        this.getRemoteAddr(req),
        userInput
      );
      if (session.getSessionStatus() === FaucetSessionStatus.FAILED) {
        return {
          status: FaucetSessionStatus.FAILED,
          failedCode: session.getSessionData("failed.code"),
          failedReason: session.getSessionData("failed.reason"),
          balance: session.getDropAmount().toString(),
          target: session.getTargetAddr(),
        };
      }

      sessionInfo = await session.getSessionInfo();
    } catch (ex) {
      if (ex instanceof FaucetError) {
        let data: any = {
          status: FaucetSessionStatus.FAILED,
          failedCode: ex.getCode(),
          failedReason: ex.message,
        };
        if (ex.data) {
          data.failedData = (ex as any).data;
        }

        return data;
      } else {
        return {
          status: FaucetSessionStatus.FAILED,
          failedCode: "INTERNAL_ERROR",
          failedReason: ex.toString(),
        };
      }
    }

    return sessionInfo;
  }

  public async onGetSession(sessionId: string): Promise<any> {
    let session: FaucetSession;
    if (
      !sessionId ||
      !(session = ServiceManager.GetService(SessionManager).getSession(
        sessionId,
        [FaucetSessionStatus.RUNNING]
      ))
    ) {
      return {
        status: "unknown",
        error: "Session not found",
      };
    }

    let sessionInfo: IClientSessionInfo;
    try {
      sessionInfo = await session.getSessionInfo();
    } catch (ex) {
      if (ex instanceof FaucetError) {
        return {
          status: FaucetSessionStatus.FAILED,
          failedCode: ex.getCode(),
          failedReason: ex.message,
        };
      } else {
        return {
          status: FaucetSessionStatus.FAILED,
          failedCode: "INTERNAL_ERROR",
          failedReason: ex.toString(),
        };
      }
    }

    return sessionInfo;
  }

  public async onClaimReward(req: IncomingMessage, body: Buffer): Promise<any> {
    if (req.method !== "POST")
      return new FaucetHttpResponse(405, "Method Not Allowed");

    let userInput = JSON.parse(body.toString("utf8"));
    let sessionData: FaucetSessionStoreData;
    if (
      !userInput ||
      !userInput.session ||
      !(sessionData = await ServiceManager.GetService(
        SessionManager
      ).getSessionData(userInput.session))
    ) {
      return {
        status: FaucetSessionStatus.FAILED,
        failedCode: "INVALID_SESSION",
        failedReason: "Session not found.",
      };
    }

    try {
      const faucetType = faucetConfig.faucetNetworkType;

      if (faucetType === "evm") {
        await ServiceManager.GetService(EthClaimManager).createSessionClaim(
          sessionData,
          userInput
        );
      } else if (faucetType === "cw") {
        await ServiceManager.GetService(CwClaimManager).createSessionClaim(
          sessionData,
          userInput
        );
      }
    } catch (ex) {
      return {
        status: FaucetSessionStatus.FAILED,
        failedCode: ex instanceof FaucetError ? ex.getCode() : "",
        failedReason: ex.message,
      };
    }

    return this.getSessionStatus(sessionData, false);
  }

  private getSessionStatus(
    sessionData: FaucetSessionStoreData,
    details: boolean
  ): IClientSessionStatus {
    let sessionStatus: IClientSessionStatus = {
      session: sessionData.sessionId,
      status: sessionData.status,
      start: sessionData.startTime,
      tasks: sessionData.tasks,
      balance: sessionData.dropAmount,
      target: sessionData.targetAddr,
    };
    if (sessionData.status === FaucetSessionStatus.FAILED && sessionData.data) {
      sessionStatus.failedCode = sessionData.data["failed.code"];
      sessionStatus.failedReason = sessionData.data["failed.reason"];
    }
    if (sessionData.claim) {
      sessionStatus.claimIdx = sessionData.claim.claimIdx;
      sessionStatus.claimStatus = sessionData.claim.claimStatus;
      sessionStatus.claimBlock = sessionData.claim.txBlock;
      sessionStatus.claimHash = sessionData.claim.txHash;
      sessionStatus.claimMessage = sessionData.claim.txError;
    }
    if (details) {
      sessionStatus.details = {
        data: sessionData.data,
        claim: sessionData.claim,
      };
    }

    return sessionStatus;
  }

  public async onGetSessionStatus(
    sessionId: string,
    details: boolean
  ): Promise<any> {
    let sessionData: FaucetSessionStoreData;
    if (
      !sessionId ||
      !(sessionData = await ServiceManager.GetService(
        SessionManager
      ).getSessionData(sessionId))
    )
      return new FaucetHttpResponse(404, "Session not found");

    return this.getSessionStatus(sessionData, details);
  }

  public async onGetQueueStatus(): Promise<any> {
    let now = Math.floor(new Date().getTime() / 1000);
    let cachedRsp,
      cacheKey = "queue";
    if (
      !(cachedRsp = this.cachedStatusData[cacheKey]) ||
      cachedRsp.time < now - FAUCETSTATUS_CACHE_TIME
    ) {
      cachedRsp = this.cachedStatusData[cacheKey] = {
        time: now,
        data: buildQueueStatus(),
      };
    }
    return cachedRsp.data;
  }

  public async onGetFaucetStatus(key: string): Promise<any> {
    if (key) {
      if (key !== sha256(faucetConfig.faucetSecret + "-unmasked"))
        return new FaucetHttpResponse(403, "Access denied");
      return Object.assign(
        await buildFaucetStatus(),
        buildQueueStatus(true),
        await buildSessionStatus(true)
      );
    }

    let now = Math.floor(new Date().getTime() / 1000);
    let cachedRsp,
      cacheKey = "faucet";
    if (
      !(cachedRsp = this.cachedStatusData[cacheKey]) ||
      cachedRsp.time < now - FAUCETSTATUS_CACHE_TIME
    ) {
      cachedRsp = this.cachedStatusData[cacheKey] = {
        time: now,
        data: Object.assign(
          await buildFaucetStatus(),
          buildQueueStatus(),
          await buildSessionStatus()
        ),
      };
    }
    return cachedRsp.data;
  }
}
