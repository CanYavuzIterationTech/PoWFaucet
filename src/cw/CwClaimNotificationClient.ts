import { WebSocket } from "ws";
import { FaucetLogLevel, FaucetProcess } from "../common/FaucetProcess.js";
import { ServiceManager } from "../common/ServiceManager.js";

export interface IClaimNotificationData {
  processedIdx: number;
  confirmedIdx: number;
}

export class CwClaimNotificationClient {
  // Constants for WebSocket management
  private static readonly PING_INTERVAL = 30; // seconds
  private static readonly PING_TIMEOUT = 120; // seconds

  private static activeClients: CwClaimNotificationClient[] = [];
  private static lastNotificationData: IClaimNotificationData | null;

  public static broadcastClaimNotification(data: IClaimNotificationData) {
    this.lastNotificationData = data;
    // Broadcast to all active clients
    for (let i = this.activeClients.length - 1; i >= 0; i--) {
      this.activeClients[i].sendClaimNotification(data);
    }
  }

  public static resetClaimNotification() {
    this.lastNotificationData = null;
  }

  private socket: WebSocket | null;
  private pingTimer: NodeJS.Timeout | null = null;
  private lastPingPong: Date;
  private claimIdx: number;

  public constructor(socket: WebSocket, claimIdx: number) {
    this.socket = socket;
    this.claimIdx = claimIdx;
    this.lastPingPong = new Date();

    // Set up WebSocket event handlers
    this.socket.on("ping", (data) => {
      this.lastPingPong = new Date();
      this.socket?.pong(data);
    });

    this.socket.on("pong", () => {
      this.lastPingPong = new Date();
    });

    this.socket.on("error", (err) => {
      ServiceManager.GetService(FaucetProcess).emitLog(
        FaucetLogLevel.WARNING,
        `WebSocket error: ${err.toString()}`
      );
      try {
        this.socket?.close();
      } catch (ex) {}
      this.dispose();
    });

    this.socket.on("close", () => {
      this.dispose();
    });

    this.pingClientLoop();
    CwClaimNotificationClient.activeClients.push(this);

    // Send latest notification data if available
    if (CwClaimNotificationClient.lastNotificationData) {
      this.sendClaimNotification(CwClaimNotificationClient.lastNotificationData);
    }
  }

  private dispose() {
    this.socket = null;

    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    const clientIdx = CwClaimNotificationClient.activeClients.indexOf(this);
    if (clientIdx !== -1) {
        CwClaimNotificationClient.activeClients.splice(clientIdx, 1);
    }
  }

  public killClient(reason?: string) {
    try {
      this.sendMessage("error", {
        reason: reason,
      });
      this.socket?.close();
    } catch (ex) {}
    this.dispose();
  }

  private pingClientLoop() {
    this.pingTimer = setInterval(() => {
      const pingpongTime = Math.floor(
        (new Date().getTime() - this.lastPingPong.getTime()) / 1000
      );

      if (pingpongTime > CwClaimNotificationClient.PING_TIMEOUT) {
        this.killClient("ping timeout");
        return;
      }

      this.socket?.ping();
    }, CwClaimNotificationClient.PING_INTERVAL * 1000);
  }

  private sendMessage(action: string, data: any) {
    this.socket?.send(
      JSON.stringify({
        action: action,
        data: data,
      })
    );
  }

  private sendClaimNotification(data: IClaimNotificationData) {
    this.sendMessage("update", data);
    // Close connection if claim is confirmed
    if (data.confirmedIdx >= this.claimIdx) {
      this.killClient("claim confirmed");
    }
  }
}
