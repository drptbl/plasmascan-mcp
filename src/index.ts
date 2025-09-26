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
} from "./plasmascanClient.js";

const instructions = [
  "Use `plasmascan_get_contract` to fetch ABI, source code, and metadata for verified contracts.",
  "Use `plasmascan_get_contract_logs` to stream contract event logs with optional block bounds and topics.",
  "Use `plasmascan_get_contract_creation` to inspect deployer details for up to 5 addresses.",
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
