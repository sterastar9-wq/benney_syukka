#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const [run, statusId, statusLabel] = process.argv.slice(2);
if (!run || !statusId || !statusLabel) {
  console.error('usage: node tools/write-status-view-spec.mjs <run> <status-id> <status-label>');
  process.exit(2);
}

const root = path.join('.o11y', run);
const out = path.join(root, 'api-spec');
const flowPath = path.join(root, 'flow-result.json');
const flow = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
fs.mkdirSync(out, { recursive: true });

let operationSuffix = statusLabel
  .normalize('NFKD')
  .replace(/[^\w]+/g, '_')
  .replace(/^_+|_+$/g, '')
  .toLowerCase() || `status_${statusId}`;
if (!/^[a-z_]/i.test(operationSuffix)) operationSuffix = `status_${statusId}`;
const operationId = `get_${operationSuffix}_status_orders`;
const finalUrl = flow.final?.url || `https://order.goqsystem.com/goq21/index_beta.php?stat=${statusId}&page=1`;
const page = new URL(finalUrl).searchParams.get('page') || '1';
const labelText = String(flow.final?.yamato || flow.final?.statusText || flow.final?.statusLabel || '');
const countMatch = labelText.match(/\n\s*(\d+)\s*$/);
const count = countMatch?.[1] || null;

const spec = {
  openapi: '3.1.0',
  info: {
    title: `GoQSystem ${statusLabel} Status View API`,
    version: '0.1.0-discovered',
    description: `Spec derived from the browser-trace capture of displaying the ${statusLabel} order status list. The observed flow only navigates to the status list; it does not change any orders.`,
  },
  servers: [{ url: 'https://order.goqsystem.com' }],
  paths: {
    '/goq21/index_beta.php': {
      get: {
        summary: `Display ${statusLabel} status order list`,
        operationId,
        parameters: [
          {
            name: 'stat',
            in: 'query',
            required: true,
            description: `Order status id. ${statusId} is ${statusLabel}.`,
            schema: { type: 'integer', const: Number(statusId) },
            example: Number(statusId),
          },
          {
            name: 'page',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 1, default: Number(page) },
            example: Number(page),
          },
        ],
        responses: {
          200: {
            description: 'HTML order list page for the selected status.',
            content: { 'text/html': { schema: { type: 'string' } } },
          },
        },
        'x-observed': {
          finalUrl,
          finalStat: String(flow.final?.stat || statusId),
          statusLabel,
          ...(count ? { displayedCount: Number(count) } : {}),
        },
        'x-confidence': {
          samples: 1,
          statusCodes: [200],
          normalizationFlags: ['html-page-render', 'single-sample'],
          confidence: 'low',
        },
      },
    },
  },
};

function yamlQuote(s) {
  return String(s).includes(':') || /[^\x20-\x7E]/.test(String(s)) ? JSON.stringify(String(s)) : String(s);
}

const yaml = `openapi: 3.1.0
info:
  title: ${yamlQuote(spec.info.title)}
  version: 0.1.0-discovered
  description: ${yamlQuote(spec.info.description)}
servers:
  - url: https://order.goqsystem.com
paths:
  /goq21/index_beta.php:
    get:
      summary: ${yamlQuote(spec.paths['/goq21/index_beta.php'].get.summary)}
      operationId: ${operationId}
      parameters:
        - name: stat
          in: query
          required: true
          description: ${yamlQuote(`Order status id. ${statusId} is ${statusLabel}.`)}
          schema:
            type: integer
            const: ${Number(statusId)}
          example: ${Number(statusId)}
        - name: page
          in: query
          required: false
          schema:
            type: integer
            minimum: 1
            default: ${Number(page)}
          example: ${Number(page)}
      responses:
        '200':
          description: HTML order list page for the selected status.
          content:
            text/html:
              schema:
                type: string
      x-observed:
        finalUrl: ${finalUrl}
        finalStat: '${String(flow.final?.stat || statusId)}'
        statusLabel: ${yamlQuote(statusLabel)}
${count ? `        displayedCount: ${Number(count)}\n` : ''}      x-confidence:
        samples: 1
        statusCodes:
          - 200
        normalizationFlags:
          - html-page-render
          - single-sample
        confidence: low
`;

const client = `// Client generated from the browser-trace capture of displaying the
// ${statusLabel} status list. This endpoint returns the GoQSystem HTML list
// page and relies on the caller's authenticated GoQSystem browser/session cookies.

const BASE = 'https://order.goqsystem.com';

async function request(path, { query, headers } = {}) {
  let url = BASE + path;
  if (query) {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value != null) qs.set(key, String(value));
    }
    if (qs.toString()) url += \`?\${qs}\`;
  }

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Upgrade-Insecure-Requests': '1',
      ...headers,
    },
  });

  if (!res.ok) {
    throw new Error(\`${res.status} ${res.statusText}: ${await res.text()}\`);
  }
  return res.text();
}

export async function ${operationId}({ page = ${Number(page)}, headers } = {}) {
  return request('/goq21/index_beta.php', {
    query: { stat: ${Number(statusId)}, page },
    headers,
  });
}
`;

const report = `# Discovered API

**Base URL:** \`https://order.goqsystem.com\`

The captured operation only displayed the \`${statusLabel}\` status list. No order status changes were performed.

\`\`\`js
import { ${operationId} } from './client.mjs';
\`\`\`

## Endpoints

| Method | Path | Query | Samples | Confidence |
|---|---|---|---|---|
| GET | \`/goq21/index_beta.php\` | \`stat=${statusId}&page=${page}\` | 1 | low |

## Observed Result

- Final URL: \`${finalUrl}\`
- Final \`stat\`: \`${String(flow.final?.stat || statusId)}\`
- Displayed status: \`${statusLabel}\`
${count ? `- Displayed count: \`${count}\`\n` : ''}
## Coverage

- **1** HTML page-render endpoint documented from the browser trace
- **0** order mutation requests observed
`;

fs.writeFileSync(path.join(out, 'openapi.json'), `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
fs.writeFileSync(path.join(out, 'openapi.yaml'), yaml, 'utf8');
fs.writeFileSync(path.join(out, 'client.mjs'), client, 'utf8');
fs.writeFileSync(path.join(out, 'report.md'), report, 'utf8');

console.log(JSON.stringify({ run, operationId, finalUrl, count }, null, 2));