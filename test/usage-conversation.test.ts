import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describeConversationKey } from '../web/lib/activity.ts';
import { UsageConversation } from '../web/components/usage-conversation.ts';

test('simulation identities retain distinct complete ledger keys and show their original QQ scope', () => {
  for (const kind of ['private', 'group'] as const) {
    const key = `simulation:qq-QZQC6C:${kind}:123`;
    const identity = describeConversationKey(key);
    assert.deepEqual(identity, { key, kind, identifier: '123', label: kind === 'private' ? '模拟 · 私聊' : '模拟 · 群聊',
      simulationRunId: 'qq-QZQC6C' });
    assert.notEqual(identity.key, describeConversationKey(`${kind}:123`).key);
    assert.notEqual(identity.key, describeConversationKey(`simulation:qq-another:${kind}:123`).key);
  }
  for (const malformed of ['simulation:other:private:123', 'simulation:qq-run:private:0', 'simulation:qq-run:private:123:extra']) {
    assert.equal(describeConversationKey(malformed).simulationRunId, undefined);
    assert.equal(describeConversationKey(malformed).kind, 'other');
  }
});

test('usage conversation component keeps run identifiers in tips and details while compact rows display scope and account only', () => {
  const key = 'simulation:qq-QZQC6C:private:123';
  const markup = renderToStaticMarkup(createElement(UsageConversation, { conversationKey: key }));
  const visible = markup.replace(/<[^>]*>/g, '');
  assert.match(markup, /data-usage-origin="simulation"/);
  assert.match(markup, /title="模拟运行：qq-QZQC6C/);
  assert.match(visible, /模拟 · 私聊/);
  assert.match(visible, /123/);
  assert.doesNotMatch(visible, /qq-QZQC6C|simulation:/);
  const detailed = renderToStaticMarkup(createElement(UsageConversation, { conversationKey: key, showRun: true }));
  assert.match(detailed.replace(/<[^>]*>/g, ''), /运行：qq-QZQC6C/);
  const qq = renderToStaticMarkup(createElement(UsageConversation, { conversationKey: 'private:123' }));
  assert.match(qq, /data-usage-origin="qq"/);
  assert.doesNotMatch(qq, /模拟/);
  assert.equal(renderToStaticMarkup(createElement(UsageConversation, { conversationKey: null })), '<span>未归属</span>');
});
