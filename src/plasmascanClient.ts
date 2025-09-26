import type { PlasmaScanConfig } from "./config.js";

export type PlasmaScanErrorCode =
  | "HTTP_ERROR"
  | "API_ERROR"
  | "NOT_FOUND"
  | "UNVERIFIED_CONTRACT"
  | "INVALID_RESPONSE";

type EtherscanResponse<T> = {
  status: string;
  message?: string;
  result: T;
};

type RequestOptions = {
  readonly allowZeroResult?: boolean;
};

export interface ContractAbiResult {
  readonly address: string;
  readonly abi: unknown;
}

export interface ContractSourceCodeResult {
  readonly address: string;
  readonly sourceCode: string;
  readonly abi: unknown;
  readonly contractName?: string;
  readonly compilerVersion?: string;
  readonly metadata: Record<string, string>;
}

export interface ContractCreationInfo {
  readonly contractAddress: string;
  readonly contractCreator: string;
  readonly txHash: string;
}

export interface ContractLogEntry {
  readonly address: string;
  readonly blockNumber: number;
  readonly data: string;
  readonly logIndex: number;
  readonly timeStamp: number;
  readonly topics: readonly string[];
  readonly transactionHash: string;
  readonly transactionIndex: number;
}

export interface ContractLogFilter {
  readonly address?: string;
  readonly fromBlock?: number;
  readonly toBlock?: number;
  readonly topics?: readonly (string | null)[];
  readonly page?: number;
  readonly offset?: number;
}

export class PlasmaScanError extends Error {
  public readonly code: PlasmaScanErrorCode;
  public readonly url: string;
  public readonly details?: unknown;

  constructor(message: string, code: PlasmaScanErrorCode, url: string, details?: unknown) {
    super(message);
    this.name = "PlasmaScanError";
    this.code = code;
    this.url = url;
    this.details = details;
  }
}

export class PlasmaScanClient {
  constructor(private readonly config: PlasmaScanConfig, private readonly fetchFn: typeof fetch = fetch) {}

  public async getContractAbi(address: string): Promise<ContractAbiResult> {
    const trimmedAddress = this.requireAddress(address);
    const result = await this.request<string>(
      {
        module: "contract",
        action: "getabi",
        address: trimmedAddress,
      },
      { allowZeroResult: false }
    );

    const abi = this.parseAbi(result, trimmedAddress);

    return { address: trimmedAddress, abi };
  }

  public async getContractSourceCode(address: string): Promise<ContractSourceCodeResult> {
    const trimmedAddress = this.requireAddress(address);
    const result = await this.request<ContractSourceCodePayload[]>(
      {
        module: "contract",
        action: "getsourcecode",
        address: trimmedAddress,
      },
      { allowZeroResult: false }
    );

    const [first] = result;
    if (!first) {
      throw new PlasmaScanError("Empty response received while fetching source code", "INVALID_RESPONSE", this.config.baseUrl, result);
    }

    const abi = this.parseAbi(first.ABI, trimmedAddress);

    const metadataEntries = Object.entries(first).filter(
      ([key, value]) => key !== "SourceCode" && key !== "ABI" && value !== undefined
    ) as Array<[string, string]>;

    const metadata = Object.fromEntries(metadataEntries);

    return {
      address: trimmedAddress,
      sourceCode: first.SourceCode,
      abi,
      metadata,
      ...(first.ContractName ? { contractName: first.ContractName } : {}),
      ...(first.CompilerVersion ? { compilerVersion: first.CompilerVersion } : {}),
    } satisfies ContractSourceCodeResult;
  }

  public async getContractCreation(addresses: readonly string[]): Promise<readonly ContractCreationInfo[]> {
    if (addresses.length === 0) {
      return [];
    }

    if (addresses.length > 5) {
      throw new PlasmaScanError("The getcontractcreation endpoint accepts up to 5 addresses per request", "INVALID_RESPONSE", this.config.baseUrl);
    }

    const normalizedAddresses = addresses.map((addr) => this.requireAddress(addr));

    const result = await this.request<ContractCreationInfo[]>(
      {
        module: "contract",
        action: "getcontractcreation",
        contractaddresses: normalizedAddresses.join(","),
      },
      { allowZeroResult: true }
    );

    return result ?? [];
  }

  public async getLogs(filter: ContractLogFilter): Promise<readonly ContractLogEntry[]> {
    const params: Record<string, string> = {
      module: "logs",
      action: "getLogs",
    };

    if (filter.address) {
      params.address = this.requireAddress(filter.address);
    }

    if (typeof filter.fromBlock === "number") {
      params.fromBlock = filter.fromBlock.toString(10);
    }

    if (typeof filter.toBlock === "number") {
      params.toBlock = filter.toBlock.toString(10);
    }

    if (typeof filter.page === "number") {
      params.page = filter.page.toString(10);
    }

    if (typeof filter.offset === "number") {
      params.offset = filter.offset.toString(10);
    }

    if (filter.topics?.length) {
      filter.topics.forEach((topic, index) => {
        if (topic === null) {
          return;
        }

        params[`topic${index}`] = topic;
      });
    }

    const result = await this.request<ContractLogPayload[]>(params, { allowZeroResult: true });

    if (!Array.isArray(result)) {
      throw new PlasmaScanError("Unexpected logs payload", "INVALID_RESPONSE", this.config.baseUrl, result);
    }

    return result.map((entry) => ({
      address: entry.address,
      blockNumber: parseInt(entry.blockNumber, 10),
      data: entry.data,
      logIndex: parseInt(entry.logIndex, 10),
      timeStamp: parseInt(entry.timeStamp, 10),
      topics: entry.topics,
      transactionHash: entry.transactionHash,
      transactionIndex: parseInt(entry.transactionIndex, 10),
    }));
  }

  private requireAddress(address: string): string {
    const trimmed = address.trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(trimmed)) {
      throw new PlasmaScanError(`Invalid EVM address: ${address}`, "INVALID_RESPONSE", this.config.baseUrl);
    }

    return trimmed;
  }

  private parseAbi(rawAbi: string, address: string): unknown {
    const trimmed = rawAbi.trim();

    if (!trimmed) {
      throw new PlasmaScanError(`Empty ABI returned for ${address}`, "INVALID_RESPONSE", this.config.baseUrl);
    }

    if (/not verified/i.test(trimmed)) {
      throw new PlasmaScanError(`Contract ${address} is not verified`, "UNVERIFIED_CONTRACT", this.config.baseUrl, rawAbi);
    }

    try {
      return JSON.parse(trimmed);
    } catch (error) {
      throw new PlasmaScanError(`Failed to parse ABI for ${address}`, "INVALID_RESPONSE", this.config.baseUrl, error);
    }
  }

  private async request<T>(params: Record<string, string>, options: RequestOptions = {}): Promise<T> {
    const url = new URL(this.config.baseUrl);
    const searchParams = new URLSearchParams(params);

    if (this.config.apiKey) {
      searchParams.set("apikey", this.config.apiKey);
    }

    url.search = searchParams.toString();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    try {
      const response = await this.fetchFn(url, { signal: controller.signal });

      if (!response.ok) {
        throw new PlasmaScanError(`HTTP error ${response.status} while calling PlasmaScan`, "HTTP_ERROR", url.href, {
          status: response.status,
          statusText: response.statusText,
        });
      }

      const payload = (await response.json()) as EtherscanResponse<T>;

      if (payload.status === "1") {
        return payload.result;
      }

      if (options.allowZeroResult && this.isEmptyResult(payload)) {
        return payload.result;
      }

      const fallbackMessage = this.extractErrorMessage(payload);
      throw new PlasmaScanError(fallbackMessage, "API_ERROR", url.href, payload);
    } catch (error) {
      if (error instanceof PlasmaScanError) {
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw new PlasmaScanError("PlasmaScan request timed out", "HTTP_ERROR", url.href, error);
      }

      throw new PlasmaScanError("Unexpected error while calling PlasmaScan", "HTTP_ERROR", url.href, error);
    } finally {
      clearTimeout(timeout);
    }
  }

  private isEmptyResult<T>(payload: EtherscanResponse<T>): boolean {
    const message = payload.message?.toLowerCase().trim();
    return message === "no records found" || message === "no transactions found";
  }

  private extractErrorMessage<T>(payload: EtherscanResponse<T>): string {
    if (typeof payload.result === "string" && payload.result.trim().length > 0) {
      return payload.result;
    }

    if (payload.message && payload.message.trim().length > 0) {
      return payload.message;
    }

    return "Unknown API error";
  }
}

type ContractSourceCodePayload = {
  readonly SourceCode: string;
  readonly ABI: string;
  readonly ContractName?: string;
  readonly CompilerVersion?: string;
  readonly Proxy?: string;
  readonly Implementation?: string;
  readonly ContractAddress?: string;
  readonly Library?: string;
  readonly LicenseType?: string;
  readonly SwarmSource?: string;
  readonly [key: string]: string | undefined;
};

type ContractLogPayload = {
  readonly address: string;
  readonly blockNumber: string;
  readonly data: string;
  readonly logIndex: string;
  readonly timeStamp: string;
  readonly topics: readonly string[];
  readonly transactionHash: string;
  readonly transactionIndex: string;
};
