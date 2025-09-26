# PlasmaScan MCP Server

A Model Context Protocol (MCP) server that exposes PlasmaScan (Routescan) contract data so LLM agents can fetch verified contract ABIs, source code, deployer information, and event logs.

## Features

- `plasmascan_get_contract` – returns ABI, source code, metadata, and optional deployment info for a verified contract.
- `plasmascan_get_contract_logs` – queries contract events with optional block boundaries, pagination, and topic filters.
- `plasmascan_get_contract_creation` – fetches deployer address and creation transaction hash for up to five contracts.
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
command = "node"
args = ["/full-path-to/plasmascan-mcp/dist/index.js"]
env = {}
```

Adjust the `args` path if the repository lives elsewhere or if you prefer running the TypeScript entry point (e.g., replace with `"./node_modules/.bin/tsx", "src/index.ts"`).

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

## Resource Template

- `plasmascan://contract/{address}` – loads the same payload returned by `plasmascan_get_contract` (all optional fields included) as a JSON document.

## Notes

- PlasmaScan free tier allows 2 requests per second with up to 10,000 calls per day.
- All HTTP requests honour the configured timeout and surface structured MCP errors when PlasmaScan signals a failure.
