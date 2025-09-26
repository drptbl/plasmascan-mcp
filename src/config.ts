import dotenv from "dotenv";

dotenv.config();

export interface PlasmaScanConfig {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly networkId: string;
  readonly chainId: string;
  readonly requestTimeoutMs: number;
}

const DEFAULT_NETWORK_ID = "mainnet";
const DEFAULT_CHAIN_ID = "9745";
const DEFAULT_TIMEOUT_MS = 15_000;

const networkId = process.env.PLASMASCAN_NETWORK_ID?.trim() || DEFAULT_NETWORK_ID;
const chainId = process.env.PLASMASCAN_CHAIN_ID?.trim() || DEFAULT_CHAIN_ID;
const apiKey = process.env.PLASMASCAN_API_KEY?.trim() || undefined;
const timeoutInput = process.env.PLASMASCAN_TIMEOUT_MS ?? "";
const parsedTimeout = Number.parseInt(timeoutInput, 10);
const timeoutMs = Number.isFinite(parsedTimeout)
  ? Math.max(1_000, parsedTimeout)
  : DEFAULT_TIMEOUT_MS;

const rawBaseUrl = process.env.PLASMASCAN_BASE_URL?.trim();
const baseUrl = (rawBaseUrl && rawBaseUrl.length > 0
  ? rawBaseUrl
  : `https://api.routescan.io/v2/network/${networkId}/evm/${chainId}/etherscan/api`
).replace(/\/$/, "");

export const config: PlasmaScanConfig = {
  baseUrl,
  networkId,
  chainId,
  requestTimeoutMs: timeoutMs,
  ...(apiKey ? { apiKey } : {}),
};
