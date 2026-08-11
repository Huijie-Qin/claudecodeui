#!/usr/bin/env node

const DEFAULT_BASES = [
  'http://host.docker.internal:3002/api/demo-data',
  'http://127.0.0.1:3001/api/demo-data',
  'http://127.0.0.1:3002/api/demo-data',
];

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) continue;
    const key = argument.slice(2);
    if (key === 'schema') {
      result.schema = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    result[key] = value;
    index += 1;
  }
  return result;
}

async function fetchFirst(pathname, bases) {
  const failures = [];
  for (const base of bases) {
    const url = `${base.replace(/\/$/, '')}${pathname}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      const body = await response.text();
      if (!response.ok) throw new Error(`${response.status} ${body}`);
      return JSON.parse(body);
    } catch (error) {
      failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Music report API is unavailable.\n${failures.join('\n')}`);
}

const args = parseArgs(process.argv.slice(2));
const bases = args['base-url'] ? [args['base-url']] : process.env.CCUI_DEMO_DATA_BASE_URL
  ? [process.env.CCUI_DEMO_DATA_BASE_URL]
  : DEFAULT_BASES;

let path;
if (args.schema) {
  path = '/music-reports/schema';
} else {
  const params = new URLSearchParams();
  for (const [argument, parameter] of [
    ['start-date', 'startDate'],
    ['end-date', 'endDate'],
    ['apps', 'apps'],
    ['dimensions', 'dimensions'],
    ['metrics', 'metrics'],
  ]) {
    if (args[argument]) params.set(parameter, args[argument]);
  }
  path = `/music-reports/query?${params.toString()}`;
}

const result = await fetchFirst(path, bases);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
