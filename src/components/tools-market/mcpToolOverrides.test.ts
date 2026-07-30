import assert from 'node:assert/strict';
import test from 'node:test';

import { getToolParameterFields } from './mcpToolOverrides';

test('reads the first JSON Schema example without replacing the default value', () => {
  const fields = getToolParameterFields({
    name: 'search_documents',
    inputSchema: {
      type: 'object',
      properties: {
        filters: {
          type: 'array',
          default: [{ field: 'status', operator: 'eq', value: 'enabled' }],
          examples: [
            [{ field: 'owner', operator: 'contains', value: 'platform' }],
          ],
        },
      },
    },
  });

  assert.deepEqual(fields, [{
    key: 'filters',
    kind: 'array',
    required: false,
    description: '',
    enumValues: undefined,
    defaultValue: [{ field: 'status', operator: 'eq', value: 'enabled' }],
    exampleValue: [{ field: 'owner', operator: 'contains', value: 'platform' }],
  }]);
});

test('falls back to the singular JSON Schema example field', () => {
  const [field] = getToolParameterFields({
    name: 'lookup_document',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: {
          type: 'string',
          description: ' Search query. ',
          example: 'deployment policy',
        },
      },
    },
  });

  assert.equal(field.required, true);
  assert.equal(field.description, 'Search query.');
  assert.equal(field.defaultValue, undefined);
  assert.equal(field.exampleValue, 'deployment policy');
});
