# ShamCash MCP bridge

Stateless MCP-over-HTTP bridge for the documented `api-shamcash.com` REST routes.

## Deployment

- Runtime: Node.js 20+
- Build command: `npm run check`
- Start command: `npm start`
- Health check: `/health`
- MCP endpoint: `/mcp`

No ShamCash API token is configured in the service. The plugin client sends the user-provided API key through the secure Bearer connection. The bridge forwards that key only to the fixed `https://api-shamcash.com/api/v1` origin and never logs or persists it.

## Available tools

- `shamcash_list_wallets`
- `shamcash_get_wallet_balance`
- `shamcash_list_wallet_transactions`
- `shamcash_call_documented_route` (allow-listed routes only)

Mutating operations require a confirmation string, and the caller is instructed to confirm the exact action, recipient/wallet, amount/currency and payload in the current conversation. The API's own key permissions remain authoritative. Do not invent route fields or use a real wallet for test transfers.

## Important limits

This is not browser automation for the ShamCash dashboard. It exposes allow-listed API routes only. The provider's available endpoints and the connected API key determine the actual access. Review `https://api-shamcash.com/docs` before calling routes that mutate data or move money.
