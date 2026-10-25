import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { normalizeContent } from '../../src/core/content.ts';
import { assertRequiredEventOutcomes } from '../../src/core/event-reports.ts';
import type { FeatureDefinition, FeatureExecution, FrameworkEvent, JsonObject } from '../../src/core/types.ts';
import { assert, errorCode, isRecord } from '../../src/core/values.ts';
import { digest } from '../../src/host/data.ts';
import { defineNativeBootstrap, type NativeBootstrapHost } from '../../src/host/native-bootstrap.ts';
import { createPresentationEffect, createPresentationService, type PresentationServiceOptions } from '../../src/host/presentation.ts';
import { createResourceRegistry } from '../../src/host/resources.ts';
import { createMessageRouter } from '../../src/host/routing.ts';
import { createCalendarTriggerService } from '../../src/host/triggers.ts';

async function operatorGrants(filename: string): Promise<readonly JsonObject[]> {
  const descriptor = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const information = await descriptor.stat();
    assert(information.isFile() && information.nlink === 1 && (information.mode & 0o077) === 0 && information.size <= 32768,
      'EXAMPLE_GRANTS_DENIED', 'A separate private bounded operator grants document is required.');
    const bytes = Buffer.alloc(32769);
    let length = 0;
    while (length < bytes.length) {
      const chunk = await descriptor.read(bytes, length, bytes.length - length, length);
      if (chunk.bytesRead === 0) break;
      length += chunk.bytesRead;
    }
    assert(length <= 32768, 'EXAMPLE_GRANTS_DENIED', 'The operator grants document exceeds its bound.');
    const document: unknown = JSON.parse(bytes.subarray(0, length).toString('utf8'));
    assert(isRecord(document) && Object.keys(document).length === 1 && Array.isArray(document.grants)
      && document.grants.length <= 32, 'EXAMPLE_GRANTS_DENIED', 'Explicit bounded operator grants are required.');
    return document.grants.map(value => {
      assert(isRecord(value) && Object.keys(value).length === 6
        && ['id', 'featureId', 'conversationId', 'capabilities', 'maxUses', 'expiresAt'].every(key => Object.hasOwn(value, key)),
      'EXAMPLE_GRANTS_DENIED', 'Only explicit policy grant fields are supported.');
      return value as JsonObject;
    });
  } finally { await descriptor.close(); }
}

export function createNativeExtensionExample({ clock = Date.now, calendarClock = clock, tickMs = 1000, rendering = {},
  runWork = async (text: string, signal: AbortSignal) => { signal.throwIfAborted(); return `# 后台整理结果\n\n${text}`; } }:
  { clock?: () => number; calendarClock?: () => number; tickMs?: number;
    rendering?: Pick<PresentationServiceOptions, 'renderer' | 'publishImage'>;
    runWork?: (text: string, signal: AbortSignal) => Promise<string> } = {}) {
  assert(Number.isSafeInteger(tickMs) && tickMs >= 10 && tickMs <= 60000, 'EXAMPLE_INVALID_OPTIONS', 'A bounded calendar tick is required.');
  return defineNativeBootstrap({ manifest: { id: 'operator-example', version: '1.0.0', apiVersion: 1 }, create(context) {
    const featureId = 'operator-example';
    const prefix = '/后台整理 同意: ';
    const proofNamespace = 'example.source-consent';
    let host: NativeBootstrapHost | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let unregister: (() => void) | undefined;
    const registry = createResourceRegistry({ store: context.store, rootDirectory: context.directory, clock });
    const presentation = createPresentationService({ capabilities: { contentTypes: ['text', 'mention', 'reply', 'image', 'audio', 'forward'] },
      ...rendering, select(input, signal, metadata) {
        signal.throwIfAborted();
        const resolved = context.context.resolve({ persona: metadata.scope.persona, conversationId: metadata.conversationId,
          ...(metadata.scope.sessionId === undefined ? {} : { sessionId: metadata.scope.sessionId }) });
        const format = resolved.preferences.replyPresentation ?? resolved.configuration.replyPresentation;
        return format === 'forward' || format === 'markdown-image' ? { format, quote: false } : input.suggested;
      } });
    const router = createMessageRouter({ rules: [{ id: 'explicit-work', priority: 100, route: 'work', relayToAgent: false,
      selector: message => message.directed && !message.isSelf && message.content.length === 1
        && message.content[0].type === 'text' && message.content[0].text.startsWith(prefix)
        && message.content[0].text.length > prefix.length && message.content[0].text.length <= 16000 }],
    defaultRoute: { route: 'chat', relayToAgent: true } });
    const calendar = createCalendarTriggerService({ store: context.store, clock: calendarClock, async callback(occurrence) {
      assert(host, 'EXAMPLE_NOT_STARTED', 'The bootstrap has not started.');
      const report = await host.engine.emit({ id: occurrence.id, type: 'trigger.fired', conversationId: occurrence.scope,
        data: { kind: 'operator-example' } }, { signal: AbortSignal.any([context.signal, occurrence.signal]) });
      assertRequiredEventOutcomes(report, [featureId]);
    } });

    async function publish(execution: FeatureExecution, body: string) {
      const prepared = await execution.invoke('presentation.prepare', { body, purpose: 'document' });
      assert(isRecord(prepared), 'EXAMPLE_INVALID_PRESENTATION', 'A prepared document is required.');
      const receipt = await execution.send(normalizeContent(prepared.content));
      assert(receipt.status === 'confirmed', receipt.status === 'unknown' ? 'EXAMPLE_SEND_UNKNOWN' : 'EXAMPLE_SEND_REJECTED',
        'The result was not confirmed.');
    }
    const feature: FeatureDefinition = { id: featureId, version: '1.0.0', apiVersion: 1,
      capabilities: ['example.work.schedule', 'presentation.prepare', 'messaging.send', 'messaging.forward'],
      subscriptions: ['message.received', 'example.work-ready', 'trigger.fired', 'example.context-ready'], setup(services) {
        services.on('message.received', async (execution, event) => {
          const routing = event.data.routing;
          if (!isRecord(routing) || routing.route !== 'work') return;
          await execution.invoke('example.work.schedule', {});
        });
        services.on('example.work-ready', async (execution, event) => { await publish(execution, String(event.data.body)); });
        const notice = async (execution: FeatureExecution, event: FrameworkEvent) => {
          if (event.data.kind !== 'operator-example') return;
          await publish(execution, String(execution.context.preferences.noticeText ?? '已到约定的整理时间。'));
        };
        services.on('trigger.fired', notice);
        services.on('example.context-ready', notice);
      } };
    return {
      features: [feature],
      onebot: { forward: { senderId: '8001', senderName: '可信扩展示例', group: true, private: false },
        resolveAsset(input) {
          const filename = registry.resolve(input);
          assert(isAbsolute(filename), 'EXAMPLE_RESOURCE_DENIED', 'Only registry-approved local resources are used by this example.');
          return { file: pathToFileURL(filename).href };
        } },
      routeIncoming(message) {
        const decision = router(message);
        if (decision.route === 'work') {
          const text = message.content[0];
          assert(text.type === 'text', 'EXAMPLE_SOURCE_DENIED', 'An explicit source command is required.');
          const key = digest([message.conversationId, message.id]);
          const proof = { conversationId: message.conversationId, sourceId: message.id, userId: message.userId,
            text: text.text.slice(prefix.length) };
          const previous = context.store.read(proofNamespace, key);
          if (previous) assert(isDeepStrictEqual(previous.value, proof), 'EXAMPLE_SOURCE_CONFLICT', 'The source identity already has different content.');
          else context.store.write(proofNamespace, key, proof, { expectedRevision: null, expiresAt: clock() + 60000 });
        }
        return decision;
      },
      eventValidators: { 'example.work-ready': data => typeof data.body === 'string', 'example.context-ready': data => data.kind === 'operator-example' },
      effectAdapters: {
        'presentation.prepare': createPresentationEffect(presentation),
        'example.work.schedule': { execute(request) {
          assert(host && !request.signal.aborted, 'EXAMPLE_NOT_STARTED', 'The bootstrap has not started.');
          const key = digest([request.scope.conversationId, request.scope.eventId]);
          const proof = context.store.read(proofNamespace, key);
          assert(proof && isRecord(proof.value) && proof.value.conversationId === request.scope.conversationId,
            'EXAMPLE_SOURCE_DENIED', 'Independent source consent is required in addition to policy.');
          const id = `example-work:${key}`;
          host.tasks.schedule({ id, kind: 'example.work', scope: request.scope.conversationId, payload: { proofKey: key },
            dueAt: clock(), expiresAt: clock() + 60000, maxAttempts: 1 });
          return { id };
        } }
      },
      agentMessagePreparation: { capabilities: ['presentation.prepare'], async prepare(execution, event) {
        const content = normalizeContent(event.data.content);
        const resolved = context.context.resolve({ persona: execution.context.persona, conversationId: event.conversationId,
          ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }) });
        const format = resolved.preferences.replyPresentation ?? resolved.configuration.replyPresentation;
        if (format !== 'forward' && format !== 'markdown-image' || !content.every(block => block.type === 'text')) return content;
        const body = content.map(block => block.type === 'text' ? block.text : '').join('\n');
        const prepared = await execution.invoke('presentation.prepare', { body });
        assert(isRecord(prepared), 'EXAMPLE_INVALID_PRESENTATION', 'A prepared document is required.');
        return normalizeContent(prepared.content);
      } },
      async start(current, signal) {
        host = current;
        const grants = await operatorGrants(join(context.directory, 'extension-grants.json'));
        signal.throwIfAborted();
        for (const value of grants) {
          const previous = current.policy.describe().grants.find(grant => grant.id === value.id);
          if (previous) {
            const { id, featureId: previousFeature, conversationId, capabilities, maxUses, expiresAt } = previous;
            assert(isDeepStrictEqual({ id, featureId: previousFeature, conversationId, capabilities, maxUses, expiresAt }, value),
              'EXAMPLE_GRANT_CONFLICT', 'An existing grant cannot be changed or replenished by this example.');
          } else current.policy.grant(value);
        }
        unregister = current.tasks.register('example.work', async task => {
          const proof = context.store.read(proofNamespace, String(task.payload.proofKey));
          assert(proof && isRecord(proof.value) && proof.value.conversationId === task.scope && typeof proof.value.text === 'string',
            'EXAMPLE_SOURCE_DENIED', 'The work must retain its original source scope.');
          task.signal.throwIfAborted();
          const workSignal = AbortSignal.any([signal, task.signal]);
          const body = await runWork(proof.value.text, workSignal);
          workSignal.throwIfAborted();
          const report = await current.engine.emit({ id: `result:${task.id}`, type: 'example.work-ready', conversationId: task.scope,
            taskId: task.id, data: { body } }, { signal: workSignal });
          assertRequiredEventOutcomes(report, [featureId]);
        });
        let after: string | undefined;
        do { after = calendar.recoverInterrupted({ limit: 100, ...(after === undefined ? {} : { after }) }).next ?? undefined; }
        while (after !== undefined);
        if (!calendar.list().some(rule => rule.id === 'operator-example-daily')) calendar.register({ id: 'operator-example-daily', scope: 'group:7001',
          timeZone: 'Asia/Shanghai', schedule: { kind: 'daily', hour: 9, minute: 0 }, dst: { overlap: 'earlier', nonexistent: 'skip' },
          misfire: 'skip', windowMs: 60000, payload: {} });
        timer = setInterval(() => {
          if (!signal.aborted) void calendar.tick().catch(error => { process.stderr.write(`${errorCode(error, 'EXAMPLE_CALENDAR_FAILED')}\n`); });
        }, tickMs);
        timer.unref();
      },
      async stop() {
        if (timer) clearInterval(timer);
        await calendar.stop();
        unregister?.();
        host = undefined;
      }
    };
  } });
}

export default createNativeExtensionExample();
