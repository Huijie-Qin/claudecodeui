import crypto from 'node:crypto';

const DEFAULT_OPENAPI_BASE_URL = 'http://127.0.0.1:3101';
const OPENAPI_REQUEST_TIMEOUT_MS = 10000;
const OPENAPI_ENDPOINT_PREFIX = '/data-agent';
const OPENAPI_AUTH_SCHEME = 'CLOUDSOA-HMAC-SHA256';
const DATA_AGENT_TENANT_HEADER = 'X-Data-Agent-Tenant';
const ACCOUNT_ID_HEADER = 'X-Account-Id';

export async function checkOpenApiAgentList({ tenantId, tenantCode, accountId } = {}) {
  const response = await requestOpenApiJson('/api/agent/list', {
    method: 'POST',
    tenantId: tenantId ?? tenantCode,
    accountId,
    body: {
      data: {
        mine: false,
        searchContent: '',
      },
      pageInfo: {
        orderId: 'modify_timestamp',
        orderType: 'desc',
        page: 1,
        pageSize: 24,
      },
    },
  });

  return { ok: true, response };
}

async function requestOpenApiJson(endpoint, { method = 'GET', body, tenantId, accountId } = {}) {
  const baseUrl = getOpenApiBaseUrl();
  const openApiEndpoint = toOpenApiEndpoint(endpoint);
  const url = `${baseUrl}${openApiEndpoint}`;
  const payloadText = body === undefined ? '' : JSON.stringify(body);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAPI_REQUEST_TIMEOUT_MS);
  const headers = {
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...createTenantHeaders(tenantId),
    ...createAccountHeaders(accountId),
    ...createOpenApiAuthHeaders({
      endpoint: openApiEndpoint,
      method,
      payloadText,
    }),
  };

  try {
    const response = await fetch(url, {
      method,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      body: body === undefined ? undefined : payloadText,
      signal: controller.signal,
    });

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      throw createHttpError(`OpenAPI returned a non-JSON response (${response.status} ${contentType || 'unknown content-type'})`, 502);
    }

    const responseText = await response.text();
    const payload = responseText ? JSON.parse(responseText) : {};
    assertOpenApiResponseOk(response, payload);
    return payload;
  } catch (error) {
    if (error?.statusCode) {
      throw error;
    }

    const message = error?.name === 'AbortError'
      ? `OpenAPI timed out at ${baseUrl}`
      : `OpenAPI is unavailable at ${baseUrl}: ${error?.message || error}`;
    throw createHttpError(message, 502);
  } finally {
    clearTimeout(timeout);
  }
}

function assertOpenApiResponseOk(response, payload) {
  if (!response.ok) {
    throw createHttpError(payload?.message || payload?.error || `OpenAPI returned ${response.status}`, response.status);
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'code') && Number(payload.code) !== 0) {
    throw createHttpError(payload?.message || 'OpenAPI returned an error', 502);
  }
}

function getOpenApiBaseUrl() {
  return String(process.env.PROD_DA_BASE_URL || DEFAULT_OPENAPI_BASE_URL).replace(/\/+$/, '/');
}

function toOpenApiEndpoint(endpoint) {
  const normalizedEndpoint = String(endpoint || '').startsWith('/')
    ? String(endpoint || '')
    : `/${endpoint || ''}`;
  if (normalizedEndpoint === OPENAPI_ENDPOINT_PREFIX || normalizedEndpoint.startsWith(`${OPENAPI_ENDPOINT_PREFIX}/`)) {
    return normalizedEndpoint;
  }
  return `${OPENAPI_ENDPOINT_PREFIX}${normalizedEndpoint}`;
}

function createTenantHeaders(tenantId) {
  const normalizedTenantId = String(tenantId || '').trim();
  return normalizedTenantId ? { [DATA_AGENT_TENANT_HEADER]: normalizedTenantId } : {};
}

function createAccountHeaders(accountId) {
  const normalizedAccountId = String(accountId || '').trim();
  return normalizedAccountId ? { [ACCOUNT_ID_HEADER]: normalizedAccountId } : {};
}

function createOpenApiAuthHeaders({ endpoint, method, payloadText }) {
  const appid = String(process.env.PROD_DA_APPID || '').trim();
  const authKey = String(process.env.PROD_DA_KEY || '').trim();

  if (!appid && !authKey) {
    return {};
  }
  if (!appid || !authKey) {
    throw createHttpError('OpenAPI auth requires both PROD_DA_APPID and PROD_DA_KEY', 500);
  }
  if (!/^[a-fA-F0-9]+$/.test(authKey) || authKey.length % 2 !== 0) {
    throw createHttpError('PROD_DA_KEY must be a hex string', 500);
  }

  const timestamp = String(Date.now());
  const endpointPath = new URL(endpoint, 'http://openapi.local').pathname;
  const builder = `${String(method || 'GET').toUpperCase()}&${endpointPath}&&${payloadText || ''}&appid=${appid}&timestamp=${timestamp}`;
  const signature = crypto
    .createHmac('sha256', Buffer.from(authKey, 'hex'))
    .update(builder)
    .digest('base64');

  return {
    Authorization: `${OPENAPI_AUTH_SCHEME} appid=${appid}, timestamp=${timestamp}, signature="${signature}"`,
  };
}

function createHttpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
