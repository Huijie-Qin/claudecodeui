#!/usr/bin/env node

const DEFAULT_BASES = [
  'http://host.docker.internal:3002/api/demo-data',
  'http://127.0.0.1:3001/api/demo-data',
  'http://127.0.0.1:3002/api/demo-data',
];

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function parseJson(value, fallback, label) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} 必须是有效 JSON：${error.message}`);
  }
}

async function fetchFirst(pathname, options, bases) {
  const failures = [];
  for (const base of bases) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25_000);
    try {
      const response = await fetch(`${base}${pathname}`, {
        ...options,
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(options?.headers || {}),
        },
      });
      const body = await response.text();
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${body.slice(0, 500)}`);
      }
      return JSON.parse(body);
    } catch (error) {
      failures.push(`${base}: ${error.message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(`无法访问画像接口。尝试结果：\n${failures.join('\n')}`);
}

const args = parseArgs(process.argv.slice(2));
const configuredBase = args['base-url'] || process.env.CCUI_DEMO_DATA_BASE_URL;
const bases = configuredBase ? [configuredBase.replace(/\/$/, '')] : DEFAULT_BASES;
const mode = args.mode || 'analyze';

let result;
if (mode === 'schema') {
  result = await fetchFirst('/audience-profiles/schema', { method: 'GET' }, bases);
} else {
  const filters = parseJson(args.filters, [], '--filters');
  const match = args.match || 'all';
  if (mode === 'sample') {
    result = await fetchFirst('/audience-profiles/sample', {
      method: 'POST',
      body: JSON.stringify({
        filters,
        match,
        tags: String(args.tags || '').split(',').filter(Boolean),
        limit: Number(args.limit || 20),
      }),
    }, bases);
  } else if (mode === 'analyze') {
    result = await fetchFirst('/audience-profiles/analyze', {
      method: 'POST',
      body: JSON.stringify({
        filters,
        match,
        dimensions: String(args.dimensions || 'industry,occupation,province').split(',').filter(Boolean),
        topN: Number(args['top-n'] || 10),
      }),
    }, bases);
  } else {
    throw new Error('--mode 仅支持 analyze、sample 或 schema');
  }
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
