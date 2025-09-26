# PlasmaScan MCP Server

A Model Context Protocol (MCP) server that exposes PlasmaScan (Routescan) contract data so LLM agents can fetch verified contract ABIs, source code, deployer information, and event logs.

## Features

- `plasmascan_get_contract` – returns ABI, source code, metadata, and optional deployment info for a verified contract.
- `plasmascan_get_contract_logs` – queries contract events with optional block boundaries, pagination, and topic filters.
- `plasmascan_get_contract_creation` – fetches deployer address and creation transaction hash for up to five contracts.
- `plasmascan_get_transaction_status` / `plasmascan_get_transaction_receipt_status` – inspect transaction execution and receipt flags.
- `plasmascan_get_token_*` and `plasmascan_get_address_*` – gather ERC-20 and ERC-721 metadata, balances, holders, and supply snapshots.
- Resource template `plasmascan://contract/{address}` for loading contract details directly into context.

## Prerequisites

- Node.js 18 or newer

## Installation

```bash
npm install
```

## Configuration

Environment variables (optionally via `.env`) control which PlasmaScan instance is queried:

- `PLASMASCAN_API_KEY` – API key, if you have one (not required for low-volume access).
- `PLASMASCAN_NETWORK_ID` – Network scope, defaults to `mainnet`.
- `PLASMASCAN_CHAIN_ID` – Chain identifier, defaults to `9745` (Plasma mainnet).
- `PLASMASCAN_BASE_URL` – Override the full Routescan/Etherscan-compatible endpoint.
- `PLASMASCAN_TIMEOUT_MS` – HTTP timeout in milliseconds (defaults to 15000).

## Development

Run the MCP server over stdio:

```bash
npm run dev
```

Build transpiled output:

```bash
npm run build
```

The compiled entry point is written to `dist/index.js` and can be executed with `npm start`.

### Codex CLI Integration

Add the server to Codex by updating `config.toml` (or the appropriate config file):

```toml
[mcp_servers.plasmascan]
command = "npx"
args = ["plasmascan-mcp@latest"]
env = {}
```

Adjust the `args` path if the repository lives elsewhere or if you prefer running the TypeScript entry point (e.g., replace with `"./node_modules/.bin/tsx", "src/index.ts"`).

### CLI Usage

After running `npm run build`, you can launch the MCP server directly via:

```bash
npx plasmascan-mcp
```

The `npx` command invokes the package's `bin` script (`dist/index.js`), so make sure the compiled output exists.

## Tool Reference

### plasmascan_get_contract

Input

```json
{
  "address": "0x...",
  "includeSource": true,
  "includeAbi": true,
  "includeMetadata": true,
  "includeCreation": true
}
```

Returns a JSON blob describing the contract. The `include*` flags are optional booleans that default to `true`.

### plasmascan_get_contract_logs

Input

```json
{
  "address": "0x...",
  "fromBlock": 0,
  "toBlock": 0,
  "page": 1,
  "offset": 100,
  "topics": ["0x..."]
}
```

All parameters except `address` are optional. Up to four topics are supported.

### plasmascan_get_contract_creation

Accepts either a single `address` or an `addresses` array (max length 5) and returns deployer information.

### plasmascan_get_transaction_status

Input

```json
{
  "txHash": "0x..."
}
```

Returns `status` and (if available) a `message` describing the execution outcome.

### plasmascan_get_transaction_receipt_status

Input is the same as above; output contains the receipt status flag.

### plasmascan_get_token_supply

```json
{
  "contractAddress": "0x..."
}
```

Outputs `{ "contractAddress": "0x...", "totalSupply": "..." }`.

### plasmascan_get_token_supply_history

```json
{
  "contractAddress": "0x...",
  "blockNumber": 8000000
}
```

Returns the ERC-20 supply at the requested block.

### plasmascan_get_token_balance

```json
{
  "contractAddress": "0x...",
  "holderAddress": "0x...",
  "tag": "latest"
}
```

`tag` defaults to `latest` and also accepts `earliest` or `pending`.

### plasmascan_get_token_balance_history

Same parameters as `plasmascan_get_token_balance`, but replace `tag` with `blockNumber` to capture a historical snapshot.

### plasmascan_get_token_holder_list

```json
{
  "contractAddress": "0x...",
  "page": 1,
  "offset": 10
}
```

Returns the holder list (and count) for the contract.

### plasmascan_get_token_info

Fetches the PlasmaScan metadata for an ERC-20; output includes raw payload plus decoded name, symbol, and decimals.

### plasmascan_get_address_token_holdings

Lists ERC-20 balances owned by an address.

### plasmascan_get_address_nft_holdings

Lists ERC-721 holdings (all contracts) owned by an address.

### plasmascan_get_address_nft_inventory

Filters ERC-721 holdings for an address down to a specific NFT contract.

## Resource Template

- `plasmascan://contract/{address}` – loads the same payload returned by `plasmascan_get_contract` (all optional fields included) as a JSON document.
- `plasmascan://token/{address}` – returns token metadata and total supply for a contract.

## Notes

- PlasmaScan free tier allows 2 requests per second with up to 10,000 calls per day.
- All HTTP requests honour the configured timeout and surface structured MCP errors when PlasmaScan signals a failure.
