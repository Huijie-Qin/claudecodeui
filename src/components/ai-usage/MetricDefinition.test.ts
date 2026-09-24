import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import MetricDefinition from './MetricDefinition';
import { MetricDefinitionAccess } from './metricDefinitionAccess';

test('metric explanations fail closed and only render with system-admin capability', () => {
  const detail = createElement(MetricDefinition, null, '仅 Admin 可见的计算口径');
  assert.equal(renderToStaticMarkup(detail), '');
  assert.equal(renderToStaticMarkup(createElement(MetricDefinitionAccess.Provider, { value: false }, detail)), '');
  assert.match(renderToStaticMarkup(createElement(MetricDefinitionAccess.Provider, { value: true }, detail)), /仅 Admin 可见的计算口径/);
});
