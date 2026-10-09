import assert from 'node:assert/strict';
import { before, test } from 'node:test';

import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { renderToStaticMarkup } from 'react-dom/server';

import { ExecutionTaskLink } from './ExecutionTaskLink';
import { ExecutionTaskActivity } from './ExecutionTaskActivity';
import { ExecutionTaskPanel } from './ExecutionTaskPanel';
import { buildExecutionActivity } from './executionActivity';
import { executionTranslations } from './translations';
import type { ExecutionTask } from './types';

const i18n = createInstance();
before(async () => {
  await i18n.init({ lng: 'en', resources: { en: { chat: { execution: executionTranslations.en } } } });
});

function task(overrides: Partial<ExecutionTask> = {}): ExecutionTask {
  return { id: 'task-1', title: 'Inspect report output', kind: 'background', status: 'running', events: [], ...overrides };
}

function panelHtml(value: ExecutionTask, callbacks = {}, translations = i18n) {
  return renderToStaticMarkup(<I18nextProvider i18n={translations}><ExecutionTaskPanel task={value} mode="docked" onClose={() => {}} {...callbacks} /></I18nextProvider>);
}

test('completed tasks open the reported result, preserving false and escaping HTML', () => {
  const html = panelHtml(task({ status: 'completed', result: '<script>window.leak()</script>\nTOKEN=confidential' }));
  assert.match(html, /data-execution-view="result"/);
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('confidential'));
  assert.match(html, /&lt;script&gt;/);
  assert.match(panelHtml(task({ status: 'completed', result: false })), />false<\/pre>/);
  assert.match(panelHtml(task({ status: 'completed', result: 0 })), />0<\/pre>/);
});

test('completed background commands without a body show their completion summary in Result', () => {
  const value = task({
    title: 'Fetch origin with SSL verification disabled',
    command: 'git -c http.sslVerify=false -c http.sslCertRevoke=false fetch origin 2>&1',
    status: 'completed',
    summary: 'Fetch completed (exit code 0)\nTOKEN=confidential',
    exitCode: 0,
    events: [
      { id: 'started', timestamp: new Date('2026-10-09T02:29:14Z'), status: 'running', summary: 'Fetching origin' },
      { id: 'finished', timestamp: new Date('2026-10-09T02:29:15Z'), status: 'completed', summary: 'Fetch completed (exit code 0)' },
    ],
  });
  const html = panelHtml(value);
  assert.match(html, /data-execution-view="result"/);
  assert.match(html, /Completion summary/);
  assert.match(html, /Fetch completed \(exit code 0\)/);
  assert.match(html, /The task completed, but the runtime did not provide a result body\./);
  assert.ok(!html.includes('The runtime reported an empty result body'));
  assert.ok(!html.includes('confidential'));
  const afterOutputCheck = panelHtml({ ...value, events: [...value.events,
    { id: 'output-check', timestamp: new Date('2026-10-09T02:29:16Z'), status: 'completed', summary: 'TaskOutput' },
  ] });
  assert.match(afterOutputCheck, /Fetch completed \(exit code 0\)/);
  assert.ok(!afterOutputCheck.includes('>TaskOutput<'));
});

test('an explicitly empty completed result is distinguished from an absent body', () => {
  const empty = panelHtml(task({ status: 'completed', result: '', summary: 'Command completed (exit code 0)' }));
  assert.match(empty, /data-execution-view="result"/);
  assert.match(empty, /The runtime reported an empty result body\./);
  assert.ok(!empty.includes('runtime did not provide a result body'));
  assert.match(panelHtml(task({ status: 'completed', result: null })), /runtime did not provide a result body/);
  assert.match(panelHtml(task({ status: 'running' })), /data-execution-view="overview"/);
  assert.match(panelHtml(task({ status: 'failed' })), /data-execution-view="overview"/);
  assert.match(panelHtml(task({ status: 'stopped' })), /data-execution-view="overview"/);
});

test('Chinese completed result text does not imply the task is still awaiting completion', async () => {
  const translations = createInstance();
  await translations.init({ lng: 'zh-CN', resources: { 'zh-CN': { chat: { execution: executionTranslations.zh } } } });
  const html = panelHtml(task({ status: 'completed', summary: 'Fetch completed (exit code 0)' }), {}, translations);
  assert.match(html, /任务已完成，但运行时未提供结果正文/);
  assert.match(html, /结束摘要/);
  assert.ok(!html.includes('尚未收到结果正文'));
  assert.match(panelHtml(task({ status: 'completed', result: '' }), {}, translations), /运行时已上报空结果正文/);
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

test('completed history shows execution phases instead of an active Running badge', async () => {
  const value = task({
    title: 'Fetch origin with SSL verification disabled',
    status: 'completed',
    events: [
      { id: 'invocation:fetch', timestamp: new Date('2026-10-09T02:29:14Z'), status: 'running', summary: 'Fetching origin' },
      { id: 'finished', timestamp: new Date('2026-10-09T02:29:15Z'), status: 'completed', summary: 'Fetch completed (exit code 0)' },
    ],
  });
  const activityHtml = (translations = i18n) => renderToStaticMarkup(
    <I18nextProvider i18n={translations}><ExecutionTaskActivity items={buildExecutionActivity(value)} /></I18nextProvider>,
  );
  const html = activityHtml();
  assert.match(html, /data-execution-event-kind="started"/);
  assert.match(html, /data-execution-event-kind="completed"/);
  assert.match(html, />Started<\/span>/);
  assert.match(html, />Execution completed<\/span>/);
  assert.match(html, /dateTime="2026-10-09T02:29:14.000Z"/);
  assert.match(html, /Fetch completed \(exit code 0\)/);
  assert.ok(!html.includes('Running'));
  assert.ok(!html.includes('animate-spin'));
  assert.ok(!html.includes('loader-circle'));
  const translations = createInstance();
  await translations.init({ lng: 'zh-CN', resources: { 'zh-CN': { chat: { execution: executionTranslations.zh } } } });
  const chinese = activityHtml(translations);
  assert.match(chinese, />已启动<\/span>/);
  assert.match(chinese, />执行完成<\/span>/);
  assert.match(chinese, /顶部状态表示任务当前状态/);
  assert.ok(!chinese.includes('运行中'));
  assert.ok(!chinese.includes('animate-spin'));
  assert.match(panelHtml({ ...value, status: 'running' }), />Running<\/span>/);
  assert.match(panelHtml({ ...value, status: 'running' }), /motion-safe:animate-spin/);
  assert.ok(!panelHtml(value).includes('motion-safe:animate-spin'));
});

test('activity tab count uses the execution timeline rather than duplicate lifecycle receipts', () => {
  const value = task({ status: 'completed', events: [
    { id: 'invocation:fetch', timestamp: new Date('2026-10-09T02:29:14Z'), status: 'running', summary: 'Fetching origin' },
    { id: 'result:fetch', timestamp: new Date('2026-10-09T02:29:14Z'), status: 'running', summary: 'Fetching origin', result: '' },
    { id: 'finished:1', timestamp: new Date('2026-10-09T02:29:15Z'), status: 'completed', summary: 'Fetch completed (exit code 0)' },
    { id: 'finished:2', timestamp: new Date('2026-10-09T02:29:16Z'), status: 'completed', summary: 'Fetch completed (exit code 0)' },
  ] });
  const html = panelHtml(value);
  assert.match(html, /data-execution-tab="activity"[^>]*>Activity<span[^>]*>2<\/span>/);
  assert.equal(value.events.length, 4);
});

test('historical output preserves payload formatting and visible-secret redaction', () => {
  const html = renderToStaticMarkup(<I18nextProvider i18n={i18n}><ExecutionTaskActivity items={[
    { id: 'partial', kind: 'output', timestamp: new Date('2026-10-09T02:29:14Z'), status: 'running', summary: 'TOKEN=confidential', result: '<script>output</script>\nAPI_KEY=private-key' },
    { id: 'query', kind: 'result', timestamp: new Date('2026-10-09T02:29:16Z'), status: 'completed', summary: 'TaskOutput', result: false },
  ]} /></I18nextProvider>);
  assert.match(html, />Output reported<\/span>/);
  assert.match(html, />Result queried<\/span>/);
  assert.match(html, /&lt;script&gt;output&lt;\/script&gt;/);
  assert.match(html, />false<\/pre>/);
  assert.ok(!html.includes('confidential'));
  assert.ok(!html.includes('private-key'));
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('animate-spin'));
});
