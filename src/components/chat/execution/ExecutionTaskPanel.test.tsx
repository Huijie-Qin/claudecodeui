import assert from 'node:assert/strict';
import { before, test } from 'node:test';

import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { renderToStaticMarkup } from 'react-dom/server';

import { ExecutionTaskLink } from './ExecutionTaskLink';
import { ExecutionTaskPanel } from './ExecutionTaskPanel';
import { executionTranslations } from './translations';
import type { ExecutionTask } from './types';

const i18n = createInstance();
before(async () => {
  await i18n.init({ lng: 'en', resources: { en: { chat: { execution: executionTranslations.en } } } });
});

function task(overrides: Partial<ExecutionTask> = {}): ExecutionTask {
  return { id: 'task-1', title: 'Inspect report output', kind: 'background', status: 'running', events: [], ...overrides };
}

function panelHtml(value: ExecutionTask, callbacks = {}) {
  return renderToStaticMarkup(<I18nextProvider i18n={i18n}><ExecutionTaskPanel task={value} mode="docked" onClose={() => {}} {...callbacks} /></I18nextProvider>);
}

test('completed tasks open the reported result, preserving false and escaping HTML', () => {
  const html = panelHtml(task({ status: 'completed', result: '<script>window.leak()</script>\nTOKEN=confidential' }));
  assert.match(html, /data-execution-view="result"/);
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('confidential'));
  assert.match(html, /&lt;script&gt;/);
  assert.match(panelHtml(task({ status: 'completed', result: false })), />false<\/pre>/);
});

test('background detail keeps source links without execution or conversation controls', () => {
  const html = panelHtml(task({ status: 'failed', sourceMessageId: 'source-1', parentAgentId: 'agent-1' }), {
    onLocateTask: () => {}, onOpenParent: () => {},
  });
  assert.match(html, /Locate in conversation/);
  assert.match(html, /Open parent subagent/);
  assert.ok(!html.includes('Discuss in main conversation'));
  assert.ok(!html.includes('End this wait'));
  assert.ok(!html.includes('Retry'));
  assert.ok(!html.includes('<footer'));
});

test('unknown task links expose an honest status and stable lookup attributes', () => {
  const html = renderToStaticMarkup(<I18nextProvider i18n={i18n}><ExecutionTaskLink task={task({ status: 'unknown', summary: 'API_KEY=confidential' })} onOpen={() => {}} /></I18nextProvider>);
  assert.match(html, /data-execution-task-id="task-1"/);
  assert.match(html, /aria-label="Inspect report output · Status unavailable"/);
  assert.ok(!html.includes('confidential'));
  assert.ok(!html.includes('0s'));
});

test('temporary output files display an explanation without a broken file button', () => {
  const value = task({ outputFile: '/tmp/claude/tasks/task-1.output' });
  const withLink = panelHtml(value, { onFileOpen: () => {} });
  const withoutLink = panelHtml(value, {
    onFileOpen: () => {},
    outputFileUnavailableReason: 'Runtime temporary files cannot be previewed directly.',
  });
  assert.match(withoutLink, /Runtime temporary files cannot be previewed directly\./);
  assert.match(withoutLink, /\/tmp\/claude\/tasks\/task-1.output/);
  assert.match(withoutLink, /data-execution-output-unavailable/);
  assert.equal((withLink.match(/<button/g) || []).length - (withoutLink.match(/<button/g) || []).length, 1);
});

test('exit codes display only when reported, including a successful zero code', () => {
  assert.match(panelHtml(task({ exitCode: 0 })), /data-execution-exit-code="0"[^>]*>Exit code: 0/);
  assert.match(panelHtml(task({ exitCode: 2, status: 'failed' })), /Exit code: 2/);
  assert.ok(!panelHtml(task()).includes('Exit code:'));
  assert.ok(!panelHtml(task({ exitCode: NaN })).includes('Exit code:'));
});
