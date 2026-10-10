import assert from 'node:assert/strict';
import test from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { OneLineDisplay } from './OneLineDisplay';
import { scrollToToolResult } from './scrollToToolResult';

function fixture({ hasTarget = true, hasScrollport = true } = {}) {
  const scrolls: Array<{ name: string; options: ScrollToOptions }> = [];
  const outer = {
    parentElement: null,
    overflowY: 'auto',
    scrollTo: (options: ScrollToOptions) => scrolls.push({ name: 'outer', options }),
  };
  const pane = {
    parentElement: outer,
    overflowY: 'auto',
    scrollTop: 200,
    clientTop: 2,
    getBoundingClientRect: () => ({ top: 100 }),
    scrollTo: (options: ScrollToOptions) => scrolls.push({ name: 'pane', options }),
  };
  const wrapper = {
    parentElement: hasScrollport ? pane : null,
    overflowY: 'hidden',
    scrollTo: (options: ScrollToOptions) => scrolls.push({ name: 'wrapper', options }),
  };
  const target = {
    id: 'tool-result-tool:1',
    parentElement: wrapper,
    getBoundingClientRect: () => ({ top: 350 }),
  };
  const message = {
    querySelectorAll: (selector: string) => {
      assert.equal(selector, '[id]');
      return hasTarget ? [target] : [];
    },
  };
  const trigger = {
    closest: (selector: string) => {
      assert.equal(selector, '.chat-message');
      return message;
    },
    ownerDocument: {
      getElementById: () => { throw new Error('Must not resolve duplicate IDs in another timeline'); },
      defaultView: {
        getComputedStyle: (element: { overflowY: string }) => element,
      },
    },
  } as unknown as HTMLElement;
  return { trigger, scrolls };
}

test('tool result jump scrolls only the nearest message pane, including IDs with selector characters', () => {
  const { trigger, scrolls } = fixture();
  scrollToToolResult(trigger, 'tool-result-tool:1');
  assert.deepEqual(scrolls, [{ name: 'pane', options: { top: 432, behavior: 'instant' } }]);
});

test('missing local result does not jump to the same tool in another timeline', () => {
  const { trigger, scrolls } = fixture({ hasTarget: false });
  scrollToToolResult(trigger, 'tool-result-tool:1');
  assert.deepEqual(scrolls, []);
});

test('result without a message scrollport does not scroll hidden layout containers', () => {
  const { trigger, scrolls } = fixture({ hasScrollport: false });
  scrollToToolResult(trigger, 'tool-result-tool:1');
  assert.deepEqual(scrolls, []);
});

test('search result action is a non-submitting button without fragment navigation', () => {
  const html = renderToStaticMarkup(
    <OneLineDisplay toolName="Grep" value="pattern" action="jump-to-results"
      toolId="tool:1" toolResult={{ content: 'found' }} />,
  );
  assert.match(html, /<button type="button" aria-label="Jump to tool result"/);
  assert.doesNotMatch(html, /href=/);
});

test('search without a result ID does not offer a broken jump action', () => {
  const html = renderToStaticMarkup(
    <OneLineDisplay toolName="Grep" value="pattern" action="jump-to-results"
      toolResult={{ content: 'found' }} />,
  );
  assert.doesNotMatch(html, /<button|href=/);
});
