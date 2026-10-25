import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, errorMessage } from '../web/lib/api.ts';

test('ordinary API authentication errors describe the access session rather than a manually entered token', () => {
  assert.equal(errorMessage(new ApiError('unauthorized', 401)), '访问会话已失效，请重新登录。');
});
