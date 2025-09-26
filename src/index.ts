#!/usr/bin/env node

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import packageInfo from "../package.json" with { type: "json" };
import { config } from "./config.js";
import {
  PlasmaScanClient,
  PlasmaScanError,
  type ContractLogFilter,
  type ContractSourceCodeResult,
  type TokenInfoResult,
} from "./plasmascanClient.js";

const instructions = [
  "Use `plasmascan_get_contract` to fetch ABI, source code, and metadata for verified contracts.",
  "Use `plasmascan_get_contract_logs` to stream contract event logs with optional block bounds and topics.",
  "Use `plasmascan_get_contract_creation` to inspect deployer details for up to 5 addresses.",
  "Use `plasmascan_get_transaction_status` and `plasmascan_get_transaction_receipt_status` to inspect execution state.",
  "Use the token tools (`plasmascan_get_token_*` and `plasmascan_get_address_*`) for ERC-20 and ERC-721 balances, holders, and metadata.",
  "Configuration via environment variables: PLASMASCAN_API_KEY (optional), PLASMASCAN_NETWORK_ID, PLASMASCAN_CHAIN_ID, PLASMASCAN_BASE_URL, PLASMASCAN_TIMEOUT_MS.",
].join("\n");

const server = new McpServer(
  {
    name: "plasmascan-mcp",
    version: packageInfo.version ?? "0.1.0",
    description: "Expose PlasmaScan contract insight tools over MCP.",
  },
  { instructions }
);

const client = new PlasmaScanClient(config);
const transport = new StdioServerTransport();

const evmAddressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "address must be a 0x-prefixed 40 byte hex string");

const txHashSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/, "txHash must be a 0x-prefixed 32 byte hash");

const blockNumberSchema = z.number().int().min(0);

const paginationSchema = {
  page: z.number().int().min(1).optional(),
  offset: z.number().int().min(1).max(1000).optional(),
};

const tagSchema = z.enum(["latest", "earliest", "pending"]).optional();

server.registerTool(
  "plasmascan_get_contract",
  {
    title: "Fetch contract ABI and source",
    description:
      "Returns verified PlasmaScan contract data including ABI, source code, compiler metadata, and optional creation info.",
    inputSchema: {
      address: evmAddressSchema,
      includeSource: z.boolean().optional(),
      includeAbi: z.boolean().optional(),
      includeMetadata: z.boolean().optional(),
      includeCreation: z.boolean().optional(),
    },
  },
  async ({
    address,
    includeSource = true,
    includeAbi = true,
    includeMetadata = true,
    includeCreation = true,
  }) => {
    try {
      const contract = await client.getContractSourceCode(address);
      const creation = includeCreation ? await fetchCreation(address) : undefined;

      const payloadOptions: ContractPayloadOptions = {
        includeSource,
        includeAbi,
        includeMetadata,
        ...(creation ? { creation } : {}),
      };

      return createSuccessResult(buildContractPayload(contract, payloadOptions));
    } catch (error) {
      return createErrorResult(error);
    }
  }
);

server.registerTool(
  "plasmascan_get_transaction_status",
  {
    title: "Check transaction execution status",
    description: "Returns PlasmaScan execution status for a transaction hash",
    inputSchema: {
      txHash: txHashSchema,
    },
  },
  async ({ txHash }) => {
    try {
      const status = await client.getTransactionStatus(txHash);
      return createSuccessResult({
        txHash,
        status: status.status,
        message: status.message,
      });
    } catch (error) {
      return createErrorResult(error);
    }
  }
);

server.registerTool(
  "plasmascan_get_transaction_receipt_status",
  {
    title: "Check transaction receipt status",
    description: "Returns the PlasmaScan receipt success flag for a transaction hash",
    inputSchema: {
      txHash: txHashSchema,
    },
  },
  async ({ txHash }) => {
    try {
      const status = await client.getTransactionReceiptStatus(txHash);
      return createSuccessResult({
        txHash,
        status: status.status,
      });
    } catch (error) {
      return createErrorResult(error);
    }
  }
);

server.registerTool(
  "plasmascan_get_contract_logs",
  {
    title: "Fetch contract event logs",
    description:
      "Reads PlasmaScan event logs by address with optional block range, pagination, and topic filters (topic order matches Web3 indexed topics).",
    inputSchema: {
      address: evmAddressSchema,
      fromBlock: z.number().int().min(0).optional(),
      toBlock: z.number().int().min(0).optional(),
      page: z.number().int().min(1).optional(),
      offset: z.number().int().min(1).max(1000).optional(),
      topics: z
        .array(z.string().regex(/^0x[a-fA-F0-9]{64}$/, "topics must be 0x-prefixed 32 byte hashes"))
        .max(4)
        .optional(),
    },
  },
  async ({ address, fromBlock, toBlock, page, offset, topics }) => {
    const filter: ContractLogFilter = {
      address,
      ...(fromBlock !== undefined ? { fromBlock } : {}),
      ...(toBlock !== undefined ? { toBlock } : {}),
      ...(page !== undefined ? { page } : {}),
      ...(offset !== undefined ? { offset } : {}),
      ...(topics && topics.length > 0 ? { topics } : {}),
    };

    try {
      const logs = await client.getLogs(filter);
      return createSuccessResult({
        address,
        count: logs.length,
        logs,
      });
    } catch (error) {
      return createErrorResult(error);
    }
  }
);

server.registerTool(
  "plasmascan_get_contract_creation",
  {
    title: "Fetch contract deployer info",
    description: "Returns deployer address and transaction hash for up to 5 contracts in a single call.",
    inputSchema: {
      addresses: z
        .array(evmAddressSchema)
        .min(1)
        .max(5)
        .optional(),
      address: evmAddressSchema.optional(),
    },
  },
  async ({ addresses, address }) => {
    const targetAddresses = addresses?.length ? addresses : address ? [address] : [];

    if (!targetAddresses.length) {
      return createErrorResult(new Error("provide `address` or `addresses`"));
    }

    try {
      const creations = await client.getContractCreation(targetAddresses);
      return createSuccessResult({ count: creations.length, creations });
    } catch (error) {
      return createErrorResult(error);
    }
  }
);

server.registerTool(
  "plasmascan_get_token_supply",
  {
    title: "Fetch token total supply",
    description: "Returns the current ERC-20 token total supply from PlasmaScan",
    inputSchema: {
      contractAddress: evmAddressSchema,
    },
  },
  async ({ contractAddress }) => {
    try {
      const result = await client.getTokenSupply(contractAddress);
      return createSuccessResult(result);
    } catch (error) {
      return createErrorResult(error);
    }
  }
);

server.registerTool(
  "plasmascan_get_token_supply_history",
  {
    title: "Fetch token supply at a block",
    description: "Returns historical ERC-20 total supply for a specific block",
    inputSchema: {
      contractAddress: evmAddressSchema,
      blockNumber: blockNumberSchema,
    },
  },
  async ({ contractAddress, blockNumber }) => {
    try {
      const result = await client.getTokenSupplyHistory(contractAddress, blockNumber);
      return createSuccessResult(result);
    } catch (error) {
      return createErrorResult(error);
    }
  }
);

server.registerTool(
  "plasmascan_get_token_balance",
  {
    title: "Fetch ERC-20 token balance",
    description: "Returns an address balance for a given ERC-20 token",
    inputSchema: {
      contractAddress: evmAddressSchema,
      holderAddress: evmAddressSchema,
      tag: tagSchema,
    },
  },
  async ({ contractAddress, holderAddress, tag }) => {
    try {
      const result = await client.getTokenBalance(contractAddress, holderAddress, tag ?? "latest");
      return createSuccessResult(result);
    } catch (error) {
      return createErrorResult(error);
    }
  }
);

server.registerTool(
  "plasmascan_get_token_balance_history",
  {
    title: "Fetch historical token balance",
    description: "Returns an address ERC-20 balance at a specific block",
    inputSchema: {
      contractAddress: evmAddressSchema,
      holderAddress: evmAddressSchema,
      blockNumber: blockNumberSchema,
    },
  },
  async ({ contractAddress, holderAddress, blockNumber }) => {
    try {
      const result = await client.getTokenBalanceHistory(contractAddress, holderAddress, blockNumber);
      return createSuccessResult(result);
    } catch (error) {
      return createErrorResult(error);
    }
  }
);

server.registerTool(
  "plasmascan_get_token_holder_list",
  {
    title: "List top token holders",
    description: "Returns the token holder list for an ERC-20 contract with optional pagination",
    inputSchema: {
      contractAddress: evmAddressSchema,
      ...paginationSchema,
    },
  },
  async ({ contractAddress, page, offset }) => {
    try {
      const holders = await client.getTokenHolderList(contractAddress, page, offset);
      return createSuccessResult({ contractAddress, count: holders.length, holders });
    } catch (error) {
      return createErrorResult(error);
    }
  }
);

server.registerTool(
  "plasmascan_get_token_info",
  {
    title: "Fetch token metadata",
    description: "Returns token metadata (name, symbol, supply) for an ERC-20 contract",
    inputSchema: {
      contractAddress: evmAddressSchema,
    },
  },
  async ({ contractAddress }) => {
    try {
      const info = await client.getTokenInfo(contractAddress);
      return createSuccessResult({ contractAddress, info });
    } catch (error) {
      return createErrorResult(error);
    }
  }
);

server.registerTool(
  "plasmascan_get_address_token_holdings",
  {
    title: "List ERC-20 token holdings",
    description: "Returns ERC-20 token balances held by an address",
    inputSchema: {
      address: evmAddressSchema,
      ...paginationSchema,
    },
  },
  async ({ address, page, offset }) => {
    try {
      const holdings = await client.getAddressTokenHoldings(address, page, offset);
      return createSuccessResult({ address, count: holdings.length, holdings });
    } catch (error) {
      return createErrorResult(error);
    }
  }
);

server.registerTool(
  "plasmascan_get_address_nft_holdings",
  {
    title: "List ERC-721 holdings",
    description: "Returns ERC-721 token holdings for an address",
    inputSchema: {
      address: evmAddressSchema,
      ...paginationSchema,
    },
  },
  async ({ address, page, offset }) => {
    try {
      const holdings = await client.getAddressNftHoldings(address, page, offset);
      return createSuccessResult({ address, count: holdings.length, holdings });
    } catch (error) {
      return createErrorResult(error);
    }
  }
);

server.registerTool(
  "plasmascan_get_address_nft_inventory",
  {
    title: "List ERC-721 inventory for contract",
    description: "Returns ERC-721 token holdings for an address filtered by contract",
    inputSchema: {
      address: evmAddressSchema,
      contractAddress: evmAddressSchema,
      ...paginationSchema,
    },
  },
  async ({ address, contractAddress, page, offset }) => {
    try {
      const holdings = await client.getAddressNftInventory(address, contractAddress, page, offset);
      return createSuccessResult({ address, contractAddress, count: holdings.length, holdings });
    } catch (error) {
      return createErrorResult(error);
    }
  }
);

const contractResourceTemplate = new ResourceTemplate("plasmascan://contract/{address}", {
  list: undefined,
});

server.registerResource(
  "plasmascan-contract",
  contractResourceTemplate,
  {
    title: "PlasmaScan contract profile",
    description: "On-demand ABI and source for a verified PlasmaScan contract.",
    mimeType: "application/json",
  },
  async (uri, variables) => {
    const { address } = variables;

    if (typeof address !== "string") {
      throw new Error("contract resource requires an address parameter");
    }

    const result = await client.getContractSourceCode(address);
    const creation = await fetchCreation(address);
    const payloadOptions: ContractPayloadOptions = {
      includeSource: true,
      includeAbi: true,
      includeMetadata: true,
      ...(creation ? { creation } : {}),
    };

    const payload = buildContractPayload(result, payloadOptions);

    return {
      contents: [
        {
          uri: uri.href,
          text: safeStringify(payload),
        },
      ],
    };
  }
);

const tokenResourceTemplate = new ResourceTemplate("plasmascan://token/{address}", {
  list: undefined,
});

server.registerResource(
  "plasmascan-token",
  tokenResourceTemplate,
  {
    title: "PlasmaScan token metadata",
    description: "Token metadata and supply information for ERC-20 contracts.",
    mimeType: "application/json",
  },
  async (uri, variables) => {
    const { address } = variables;

    if (typeof address !== "string") {
      throw new Error("token resource requires an address parameter");
    }

    const [info, supply] = await Promise.all([
      client.getTokenInfo(address),
      client.getTokenSupply(address).catch((error) => {
        if (error instanceof PlasmaScanError && error.code === "API_ERROR") {
          return undefined;
        }

        throw error;
      }),
    ]);

    const payload = buildTokenPayload(address, info, supply?.totalSupply ?? null);

    return {
      contents: [
        {
          uri: uri.href,
          text: safeStringify(payload),
        },
      ],
    };
  }
);

await server.connect(transport);

process.on("SIGINT", async () => {
  await server.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await server.close();
  process.exit(0);
});

async function fetchCreation(address: string) {
  const [creation] = await client.getContractCreation([address]);
  return creation;
}

type ContractPayloadOptions = {
  includeSource: boolean;
  includeAbi: boolean;
  includeMetadata: boolean;
  creation?: Awaited<ReturnType<typeof fetchCreation>>;
};

function buildContractPayload(
  contract: ContractSourceCodeResult,
  options: ContractPayloadOptions
) {
  const payload: Record<string, unknown> = {
    address: contract.address,
  };

  if (options.includeAbi) {
    payload.abi = contract.abi;
  }

  if (options.includeSource) {
    payload.sourceCode = contract.sourceCode;
  }

  if (options.includeMetadata) {
    payload.metadata = {
      contractName: contract.contractName,
      compilerVersion: contract.compilerVersion,
      ...contract.metadata,
    };
  }

  if (options.creation) {
    payload.creation = options.creation;
  }

  return payload;
}

function buildTokenPayload(address: string, info: TokenInfoResult | undefined, totalSupply: string | null) {
  return {
    contractAddress: address,
    totalSupply,
    metadata: info,
  };
}

function createSuccessResult(data: unknown): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: typeof data === "string" ? data : safeStringify(data),
      },
    ],
  };
}

function createErrorResult(error: unknown): CallToolResult {
  const payload = normalizeError(error);

  return {
    isError: true,
    content: [
      {
        type: "text",
        text: safeStringify(payload),
      },
    ],
  };
}

function normalizeError(error: unknown) {
  if (error instanceof PlasmaScanError) {
    return {
      message: error.message,
      code: error.code,
      url: error.url,
      details: error.details,
    };
  }

  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack,
    };
  }

  return { message: "Unknown error", details: error };
}

function safeStringify(data: unknown): string {
  try {
    return JSON.stringify(data, null, 2);
  } catch (stringifyError) {
    return JSON.stringify({
      message: "Failed to serialize payload",
      error: stringifyError instanceof Error ? stringifyError.message : stringifyError,
    });
  }
}
