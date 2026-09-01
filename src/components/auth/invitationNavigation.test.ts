import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldRedirectAcceptedInvitation } from './invitationNavigation';

test('redirects an already-accepted invitation to the default page', () => {
  assert.equal(shouldRedirectAcceptedInvitation(410, {
    code: 'INVITATION_ALREADY_ACCEPTED',
    error: '该邀请已被接受',
  }), true);
});

test('supports the legacy accepted-invitation response message', () => {
  assert.equal(shouldRedirectAcceptedInvitation(410, {
    error: '该邀请已被接受',
  }), true);
});

test('keeps other invitation failures on the invitation page', () => {
  assert.equal(shouldRedirectAcceptedInvitation(410, {
    code: 'INVITATION_EXPIRED',
    error: '该邀请已过期',
  }), false);
  assert.equal(shouldRedirectAcceptedInvitation(404, {
    code: 'INVITATION_NOT_FOUND',
    error: '邀请不存在',
  }), false);
});
