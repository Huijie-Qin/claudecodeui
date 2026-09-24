import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18next from 'i18next';
import { I18nextProvider } from 'react-i18next';

import ClaudeStatus from './ClaudeStatus';

test('a stale Processing label is hidden after loading ends', async () => {
  const i18n = i18next.createInstance();
  await i18n.init({ lng: 'en', resources: { en: { chat: {} } }, initImmediate: false });
  const render = (isLoading: boolean) => renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <ClaudeStatus
        isLoading={isLoading}
        status={{ text: 'Processing', tokens: 0, can_interrupt: true }}
      />
    </I18nextProvider>,
  );

  assert.equal(render(false), '');
  assert.match(render(true), /Processing/);
});
