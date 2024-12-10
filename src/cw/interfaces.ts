// Transaction and Wallet Related
export interface WalletState {
  ready: boolean;
  sequence: number;
  balance: bigint;
  nativeBalance: bigint;
}

export interface TransactionResult {
  txHash: string;
  txPromise: Promise<{
    status: boolean;
    height: number;
    fee: bigint;
    gasUsed: number;
  }>;
}

// Claim Related
export enum ClaimTxStatus {
  QUEUE = "queue",
  PROCESSING = "processing",
  PENDING = "pending",
  CONFIRMED = "confirmed",
  FAILED = "failed",
}

export interface ClaimData {
  claimIdx: number;
  claimStatus: ClaimTxStatus;
  claimTime: number;
  txHash?: string;
  txHeight?: number;
  txFee?: string;
  txError?: string;
}

export interface ClaimInfo {
  session: string;
  target: string;
  amount: string;
  claim: ClaimData;
}

// Notification Related
export interface IClaimNotificationData {
  processedIdx: number;
  confirmedIdx: number;
}

// Configuration Related
export interface FaucetConfig {
  // Network Configuration
  rpcEndpoint: string;
  chainId: string;
  addressPrefix: string;
  denom: string;
  decimals: number;

  // Wallet Configuration
  mnemonic: string;

  // Token Configuration
  isNativeToken: boolean;
  contractAddress?: string;
  symbol: string;

  // Gas Configuration
  gasPrice: string;
  gasLimit: string;
  gasAmount: string;
  minGasAmount: string;

  // Faucet Limits
  minAmount: string;
  maxAmount: string;
  maxPendingTx: number;

  // Balance Thresholds
  minBalance: string;
  lowBalanceThreshold: string;

  // Refill Configuration
  refillEnabled: boolean;
  refillThreshold?: string;
  refillAmount?: string;
  refillCooldown?: number;

  // Timeouts and Intervals
  processingTimeout: number;
  webSocketTimeout: number;
  queueInterval: number;
}

// Error Related
export interface FaucetErrorData {
  code: string;
  message: string;
  details?: any;
}

// Session Related
export interface SessionClaimData extends ClaimData {
  sessionId: string;
  targetAddr: string;
  dropAmount: string;
}

// Refill Related
export interface RefillState {
  lastRefillTime: number;
  isRefilling: boolean;
  cooldownRemaining: number;
}

// WebSocket Related
export interface WSMessage {
  action: string;
  data: any;
}

// Constants
export const CONSTANTS = {
  // WebSocket
  WS_PING_INTERVAL: 30,
  WS_PING_TIMEOUT: 120,

  // Queue Processing
  DEFAULT_QUEUE_INTERVAL: 2000,
  MAX_PENDING_TXS: 5,
  HISTORY_KEEP_TIME: 1800000, // 30 minutes

  // Gas
  DEFAULT_GAS_MULTIPLIER: 1.3,

  // Refill
  MIN_REFILL_INTERVAL: 60, // 1 minute

  // Status Check
  WALLET_REFRESH_INTERVAL: 60, // 1 minute
} as const;

// Type Guards
export const isClaimInfo = (obj: any): obj is ClaimInfo => {
  return (
    obj &&
    typeof obj.session === "string" &&
    typeof obj.target === "string" &&
    typeof obj.amount === "string" &&
    obj.claim &&
    typeof obj.claim.claimIdx === "number" &&
    typeof obj.claim.claimStatus === "string"
  );
};

export const isValidAddress = (address: string, prefix: string): boolean => {
  return address?.startsWith(prefix) && address.length === prefix.length + 39;
};
