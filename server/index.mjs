import http from 'node:http';

const PORT = Number(process.env.PORT || 3000);
const API_BASE = 'https://api-shamcash.com/api/v1';
const NAME = 'shamcash-api-bridge';
const VERSION = '0.1.0';
const MAX_BODY = 1024 * 1024;
const TIMEOUT_MS = 20000;
const ROUTES = [
  'wallets', 'shamcash_balance', 'shamcash_transactions', 'shamcash_transfer',
  'shamcash_cash_in', 'shamcash_recharge_syriatel', 'shamcash_webhook',
  'syriatel_balance', 'syriatel_transactions', 'syriatel_transfer', 'invoices'
];
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

const tools = [
  {
    name: 'shamcash_list_wallets',
    description: 'List wallets available to the connected ShamCash API key. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  {
    name: 'shamcash_get_wallet_balance',
    description: 'Read a ShamCash or Syriatel Cash wallet balance.',
    inputSchema: {
      type: 'object', required: ['provider', 'wallet_address'],
      properties: {
        provider: { type: 'string', enum: ['shamcash', 'syriatel'] },
        wallet_address: { type: 'string', minLength: 1, maxLength: 300 }
      }, additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  {
    name: 'shamcash_list_wallet_transactions',
    description: 'Read transaction history for a wallet. Pass only query parameters documented by ShamCash.',
    inputSchema: {
      type: 'object', required: ['provider', 'wallet_address'],
      properties: {
        provider: { type: 'string', enum: ['shamcash', 'syriatel'] },
        wallet_address: { type: 'string', minLength: 1, maxLength: 300 },
        query: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } }
      }, additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  {
    name: 'shamcash_call_documented_route',
    description: 'Call an allow-listed ShamCash REST route. Use exact methods and JSON fields from official documentation; never guess. Before any non-GET request, obtain the user’s explicit confirmation of the exact action, wallet, recipient, amount/currency, and payload in the current conversation, then provide that confirmation. This does not expose undocumented dashboard internals.',
    inputSchema: {
      type: 'object', required: ['route', 'method'],
      properties: {
        route: { type: 'string', enum: ROUTES },
        method: { type: 'string', enum: METHODS },
        provider: { type: 'string', enum: ['shamcash', 'syriatel'] },
        wallet_address: { type: 'string', minLength: 1, maxLength: 300 },
        query: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } },
        body: { type: 'object', description: 'Exact JSON body documented by ShamCash. Do not guess field names.' },
        confirmation: { type: 'string', minLength: 6, maxLength: 1000, description: 'Current-turn confirmation of the exact action and details; required for non-GET requests.' }
      }, additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
  }
];

function rpc(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }; }
function textResult(value, isError = false) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }], isError };
}
function bearer(req) {
  const h = req.headers.authorization;
  const m = typeof h === 'string' ? /^Bearer\s+([^\s]+)$/i.exec(h.trim()) : null;
  return m ? m[1] : null;
}
function walletAddress(v) {
  if (typeof v !== 'string' || !v.trim() || v.length > 300) throw new Error('wallet_address is required and must be a short string.');
  return encodeURIComponent(v.trim());
}
function queryString(query) {
  if (query === undefined) return '';
  if (!query || typeof query !== 'object' || Array.isArray(query)) throw new Error('query must be a flat JSON object.');
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(key)) throw new Error('Invalid query parameter name.');
    if (!['string', 'number', 'boolean'].includes(typeof value)) throw new Error('Query values must be strings, numbers, or booleans.');
    params.set(key, String(value));
  }
  const value = params.toString();
  return value ? '?' + value : '';
}
function routePath(route, args) {
  const provider = args.provider || (route.startsWith('syriatel_') ? 'syriatel' : 'shamcash');
  if (!['shamcash', 'syriatel'].includes(provider)) throw new Error('Invalid provider.');
  if (route === 'wallets' || route === 'invoices') {
    if (args.wallet_address) throw new Error('wallet_address is not used for this route.');
    return route === 'wallets' ? '/wallets' : '/invoices';
  }
  const address = walletAddress(args.wallet_address);
  const isSham = route.startsWith('shamcash_');
  const isSyriatel = route.startsWith('syriatel_');
  if (isSham && provider !== 'shamcash') throw new Error('This route requires provider=shamcash.');
  if (isSyriatel && provider !== 'syriatel') throw new Error('This route requires provider=syriatel.');
  const prefix = '/wallets/' + (isSham ? 'shamcash' : 'syriatel') + '/' + address;
  if (route.endsWith('_balance')) return prefix + '/balance';
  if (route.endsWith('_transactions')) return prefix + '/transactions';
  if (route === 'shamcash_transfer' || route === 'syriatel_transfer') return prefix + '/transfer';
  if (route === 'shamcash_cash_in') return prefix + '/cash-in';
  if (route === 'shamcash_recharge_syriatel') return prefix + '/recharge-syriatel';
  if (route === 'shamcash_webhook') return prefix + '/webhook';
  throw new Error('Unsupported route.');
}
async function apiRequest(token, method, path, query, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
    const init = { method, headers, signal: controller.signal };
    if (body !== undefined && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await fetch(API_BASE + path + queryString(query), init);
    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = { response_text: raw.slice(0, 8000) }; }
    return { http_status: response.status, ok: response.ok, response: data };
  } catch (err) {
    throw new Error(err?.name === 'AbortError' ? 'ShamCash API request timed out.' : 'Could not reach ShamCash API. Check service status and connectivity.');
  } finally { clearTimeout(timer); }
}
async function callTool(name, args, token) {
  if (!token) throw new Error('Missing API key. Connect using your ShamCash API key in the secure plugin connection; never paste it into chat.');
  if (name === 'shamcash_list_wallets') return apiRequest(token, 'GET', '/wallets');
  if (name === 'shamcash_get_wallet_balance') {
    if (!['shamcash', 'syriatel'].includes(args.provider)) throw new Error('provider must be shamcash or syriatel.');
    return apiRequest(token, 'GET', '/wallets/' + args.provider + '/' + walletAddress(args.wallet_address) + '/balance');
  }
  if (name === 'shamcash_list_wallet_transactions') {
    if (!['shamcash', 'syriatel'].includes(args.provider)) throw new Error('provider must be shamcash or syriatel.');
    return apiRequest(token, 'GET', '/wallets/' + args.provider + '/' + walletAddress(args.wallet_address) + '/transactions', args.query);
  }
  if (name !== 'shamcash_call_documented_route') throw new Error('Unknown tool.');
  const route = args.route, method = args.method;
  if (!ROUTES.includes(route) || !METHODS.includes(method)) throw new Error('Route or method is not allow-listed.');
  const readOnly = new Set(['wallets', 'shamcash_balance', 'syriatel_balance', 'shamcash_transactions', 'syriatel_transactions']);
  if (readOnly.has(route) && method !== 'GET') throw new Error('This route is read-only in this connector.');
  if (route === 'invoices' && !['GET', 'POST'].includes(method)) throw new Error('Only documented GET/POST invoice methods are enabled.');
  if (method !== 'GET' && (!args.confirmation || args.confirmation.trim().length < 6)) throw new Error('Blocked: non-GET actions require explicit current-turn confirmation of the exact action.');
  return apiRequest(token, method, routePath(route, args), args.query, args.body);
}
async function readBody(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('Request body too large.');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}
function send(res, status, payload, extra = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra });
  res.end(payload === null ? '' : JSON.stringify(payload));
}
const server = http.createServer(async (req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    return send(res, 200, { ok: true, service: NAME, version: VERSION });
  }
  if (req.url !== '/mcp' || req.method !== 'POST') return send(res, 404, { error: 'Not found' });
  const token = bearer(req);
  if (!token) return send(res, 401, { error: 'Bearer API key required.' }, { 'www-authenticate': 'Bearer' });
  let message;
  try { message = await readBody(req); }
  catch (err) { return send(res, 400, rpcError(null, -32700, err.message === 'Request body too large.' ? err.message : 'Invalid JSON-RPC body.')); }
  const id = message?.id;
  const notification = !Object.prototype.hasOwnProperty.call(message || {}, 'id');
  try {
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') throw Object.assign(new Error('Invalid JSON-RPC request.'), { code: -32600 });
    if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') {
      res.writeHead(202, { 'cache-control': 'no-store' }); return res.end();
    }
    let result;
    if (message.method === 'initialize') {
      result = {
        protocolVersion: message.params?.protocolVersion || '2025-03-26',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: NAME, version: VERSION },
        instructions: 'ShamCash API bridge. The caller-provided Bearer token is forwarded for the current request only, never stored or logged. Financial and configuration mutations require explicit confirmation. Use only documented methods and fields.'
      };
    } else if (message.method === 'ping') result = {};
    else if (message.method === 'tools/list') result = { tools };
    else if (message.method === 'tools/call') {
      const name = message.params?.name;
      try { result = textResult(await callTool(name, message.params?.arguments || {}, token)); }
      catch (err) { result = textResult({ error: err?.message || 'Request failed.' }, true); }
    } else throw Object.assign(new Error('Unsupported method: ' + message.method), { code: -32601 });
    if (notification) { res.writeHead(202, { 'cache-control': 'no-store' }); return res.end(); }
    return send(res, 200, rpc(id, result));
  } catch (err) {
    if (notification) { res.writeHead(202, { 'cache-control': 'no-store' }); return res.end(); }
    return send(res, 200, rpcError(id, err.code || -32603, err.message || 'Internal error.'));
  }
});
server.requestTimeout = TIMEOUT_MS + 5000;
server.headersTimeout = TIMEOUT_MS + 10000;
server.listen(PORT, '0.0.0.0', () => console.error(NAME + ' listening on port ' + PORT));
