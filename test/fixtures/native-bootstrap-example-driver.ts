import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { normalizeContent } from '../../src/core/content.ts';
import { assertRequiredEventOutcomes } from '../../src/core/event-reports.ts';
import type { FeatureDefinition } from '../../src/core/types.ts';
import { FrameworkError, assert, errorCode, isRecord } from '../../src/core/values.ts';
import { defineNativeBootstrap } from '../../src/host/native-bootstrap.ts';
import { createPresentationEffect, createPresentationService } from '../../src/host/presentation.ts';
import { createResourceRegistry } from '../../src/host/resources.ts';
import { createNativeExtensionExample } from './native-bootstrap-example.ts';

let generation = 0;

export default defineNativeBootstrap({ manifest: { id: 'example-default-path-fixture', version: '1.0.0', apiVersion: 1 }, async create(context) {
  const instance = ++generation;
  const log = join(context.directory, 'fixture-evidence.jsonl');
  const control = join(context.directory, 'fixture-control.json');
  const record = (event: string, data: object = {}) => appendFileSync(log, `${JSON.stringify({ instance, event, ...data })}\n`, { mode: 0o600 });
  const registry = createResourceRegistry({ store: context.store, rootDirectory: context.directory });
  const resourcePrefix = `fixture-resource-${randomUUID()}`;
  const settings: unknown = JSON.parse(readFileSync(control, 'utf8'));
  assert(isRecord(settings), 'FIXTURE_CONTROL_INVALID', 'A fixture control object is required.');
  let calendarNow = Date.UTC(2030, 0, 1, 0, 59);
  const base = await createNativeExtensionExample({ calendarClock: () => calendarNow, tickMs: 10,
    rendering: settings.relayImages === true ? { renderer: { async render(input) {
      record('relay-render', { body: input.markdown });
      return [{ png: new Uint8Array([1]), width: 1, height: 1 }];
    } }, async publishImage(input) {
      record('relay-publish', { conversationId: input.conversationId, scope: input.scope });
      return `${resourcePrefix}-approved`;
    } } : {}, async runWork(text, signal) {
    if (text === 'fixture-cancel-work') {
      record('cancel-work-started');
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { setTimeout(resolve, 30); }, { once: true }));
      signal.throwIfAborted();
    }
    if (text === 'fixture-unknown-work') { record('unknown-work-started'); throw new FrameworkError('FIXTURE_WORK_UNKNOWN', 'Synthetic unknown worker outcome.'); }
    return `# 后台整理结果\n\n${text}`;
  } }).create(context);
  let timer: ReturnType<typeof setInterval> | undefined;
  let previousCommand = '';
  let previousOccurrences = '';
  const forwardOnly = createPresentationService({ capabilities: { contentTypes: ['forward'] }, select() {
    record('partial-selector');
    return { format: 'forward', quote: false };
  } });
  const resourcePath = join(context.directory, `${resourcePrefix}.png`);
  writeFileSync(resourcePath, Buffer.from('fixture-controlled-image-bytes'), { mode: 0o600 });
  for (const [suffix, scope] of [['approved', 'group:7001'], ['other-scope', 'group:7002']] as const) {
    const id = `${resourcePrefix}-${suffix}`;
    registry.register({ id, type: 'image', scope, persona: context.persona, version: '1', source: { kind: 'file', path: resourcePath } });
    registry.approve(id);
  }
  const assetFeature: FeatureDefinition = { id: 'fixture-asset', version: '1.0.0', apiVersion: 1,
    capabilities: ['messaging.send'], subscriptions: ['fixture.asset'], setup(services) {
      services.on('fixture.asset', async (execution, event) => {
        const receipt = await execution.send([{ type: 'image', assetId: String(event.data.assetId) }]);
        assert(receipt.status === 'confirmed', 'FIXTURE_ASSET_REJECTED', 'The scoped resource was not confirmed.');
      });
    } };
  const partialFeature: FeatureDefinition = { id: 'fixture-partial', version: '1.0.0', apiVersion: 1,
    capabilities: ['fixture.partial.prepare', 'messaging.send', 'messaging.forward'], subscriptions: ['fixture.partial'], setup(services) {
      services.on('fixture.partial', async execution => {
        const prepared = await execution.invoke('fixture.partial.prepare', { body: '# short document', purpose: 'document' });
        assert(isRecord(prepared), 'FIXTURE_PRESENTATION_INVALID', 'A prepared document is required.');
        const receipt = await execution.send(normalizeContent(prepared.content));
        assert(receipt.status === 'confirmed', 'FIXTURE_DELIVERY_UNKNOWN', 'The partial document was not confirmed.');
      });
    } };
  const lateFeature: FeatureDefinition = { id: 'fixture-late', version: '1.0.0', apiVersion: 1,
    capabilities: ['messaging.send'], subscriptions: ['fixture.delayed'], setup(services) {
      services.on('fixture.delayed', async execution => {
        record('late-handler-started');
        await new Promise<void>(resolve => execution.signal.addEventListener('abort', () => { setTimeout(resolve, 500); }, { once: true }));
        try { await execution.send([{ type: 'text', text: 'old-instance-must-not-send' }]); record('late-unexpected-send'); }
        catch (error) { record('late-denied', { code: errorCode(error) }); }
      });
    } };
  record('created', { persona: context.persona });
  const presentationEffect = base.effectAdapters?.['presentation.prepare'];
  assert(presentationEffect && base.agentMessagePreparation, 'FIXTURE_PRESENTATION_MISSING', 'The example preparation must be mounted.');
  const preparation = base.agentMessagePreparation;
  return { ...base, features: [...base.features ?? [], partialFeature, lateFeature, assetFeature],
    effectAdapters: { ...base.effectAdapters, 'fixture.partial.prepare': createPresentationEffect(forwardOnly),
      'presentation.prepare': { execute(request) {
        record('presentation-effect', { scope: request.scope });
        return presentationEffect.execute(request);
      } } },
    agentMessagePreparation: { ...preparation, async prepare(execution, event) {
      record('relay-input', { agentDataKeys: isRecord(event.data.agentData) ? Object.keys(event.data.agentData) : [] });
      const content = await preparation.prepare(execution, event);
      record('relay-prepared', { types: content?.map(block => block.type) ?? [] });
      return content;
    } },
    eventValidators: { ...base.eventValidators, 'fixture.partial': () => true, 'fixture.delayed': () => true,
      'fixture.asset': data => typeof data.assetId === 'string' },
    async start(host, signal) {
      const denied = await host.engine.emit({ id: `manifest-only-${instance}`, type: 'example.context-ready', conversationId: 'group:7001',
        data: { kind: 'operator-example', permissions: ['presentation.prepare', 'messaging.send'] } });
      record('manifest-only', { outcome: denied.outcomes.find(outcome => outcome.featureId === 'operator-example'),
        grants: host.policy.describe().grants.length });
      await base.start?.(host, signal);
      const initial: unknown = JSON.parse(readFileSync(control, 'utf8'));
      assert(isRecord(initial), 'FIXTURE_CONTROL_INVALID', 'A fixture control object is required.');
      record('start-entered', { mode: initial.mode, grants: host.policy.describe().grants.length,
        used: host.policy.describe().grants.find(grant => grant.id === 'fixture-extension-approval')?.used,
        extensionGrantActive: host.policy.describe().grants.find(grant => grant.id === 'fixture-extension-approval')?.active });
      if (initial.mode === 'fail') throw new FrameworkError('FIXTURE_START_FAILED', 'Synthetic start failure.');
      if (initial.mode === 'abort') await new Promise<void>((_resolve, reject) => {
        const aborted = () => { record('start-aborted'); reject(new FrameworkError('FIXTURE_START_ABORTED_UNKNOWN', 'Synthetic cancelled start.')); };
        if (signal.aborted) aborted();
        else signal.addEventListener('abort', aborted, { once: true });
      });
      timer = setInterval(() => {
        if (signal.aborted || context.signal.aborted) return;
        const occurrences = context.store.list('calendar-trigger-occurrences', { limit: 100 }).map(entry => {
          assert(isRecord(entry.value), 'FIXTURE_OCCURRENCE_INVALID', 'A persisted occurrence is required.');
          return { status: entry.value.status, errorCode: entry.value.errorCode };
        });
        const occurrenceSnapshot = JSON.stringify(occurrences);
        if (occurrenceSnapshot !== previousOccurrences) { previousOccurrences = occurrenceSnapshot; record('calendar-occurrences', { items: occurrences }); }
        const command: unknown = JSON.parse(readFileSync(control, 'utf8'));
        if (!isRecord(command) || typeof command.id !== 'string' || command.id === previousCommand || typeof command.op !== 'string') return;
        previousCommand = command.id;
        if (command.op === 'relay-settings') {
          const scope = { kind: 'conversation' as const, id: command.conversationId === 'group:7002' ? 'group:7002' : 'group:7001' };
          const values = { replyPresentation: String(command.format), permissions: ['presentation.prepare', 'messaging.forward'] };
          if (command.configuration === true) context.context.setConfiguration({ scope, source: 'operator', values });
          else context.context.setPreferences({ id: `fixture-presentation-${scope.id.replace(':', '-')}`, scope, source: 'confirmed-user', values });
          record('relay-control', { id: command.id });
          return;
        }
        if (command.op === 'relay-grant') {
          assert(Array.isArray(command.capabilities) && command.capabilities.every(value => typeof value === 'string'),
            'FIXTURE_GRANT_INVALID', 'Explicit capabilities are required.');
          const capabilities = command.capabilities.map(String);
          host.policy.grant({ id: String(command.grantId), featureId: 'agent-relay', conversationId: 'group:7001', capabilities,
            maxUses: Object.fromEntries(capabilities.map(capability => [capability, 20])), expiresAt: null });
          record('relay-control', { id: command.id });
          return;
        }
        if (command.op === 'relay-revoke') {
          for (const grant of host.policy.describe().grants) {
            if (grant.featureId === 'agent-relay' && (command.grantId === grant.id
              || command.native === true && (grant.id.startsWith('native-chat:') || grant.id.startsWith('native-chat-whitelist:')))) host.policy.revoke(grant.id);
          }
          record('relay-control', { id: command.id });
          return;
        }
        if (command.op === 'relay-snapshot') {
          record('relay-snapshot', { id: command.id, audit: host.engine.describe().audit.filter(row => row.stage === 'feature.execute'
            && row.featureId === 'agent-relay'), inbox: context.store.list('host.inbox', { limit: 100 }).flatMap(entry => {
            if (!isRecord(entry.value) || !isRecord(entry.value.event) || entry.value.event.type !== 'agent.message') return [];
            return [{ eventId: entry.value.eventId, status: entry.value.status, errorCode: entry.value.errorCode ?? null }];
          }) });
          return;
        }
        if (command.op === 'calendar') { calendarNow += 60000; record('calendar-advanced'); return; }
        if (command.op === 'calendar-next-day') {
          calendarNow = Math.floor(calendarNow / 86400000) * 86400000 + 86400000 + 3600000;
          record('calendar-advanced');
          return;
        }
        if (command.op === 'cancel-work') {
          const task = host.tasks.list().find(item => item.kind === 'example.work' && item.status === 'running');
          assert(task && host.tasks.cancel(task.id), 'FIXTURE_TASK_NOT_RUNNING', 'A running task is required.');
          try { host.tasks.retry(task.id); record('unexpected-task-retry'); }
          catch (error) { record('cancel-retry-denied', { code: errorCode(error) }); }
          return;
        }
        if (command.op === 'preference') context.context.setPreferences({ id: 'fixture-confirmed-preference',
          scope: { kind: 'conversation', id: 'group:7001' }, source: 'confirmed-user', values: { noticeText: '上下文偏好通知', permissions: ['made.up'] } });
        if (command.op === 'revoke') host.policy.revoke('fixture-extension-approval');
        const type = command.op === 'partial' ? 'fixture.partial' : command.op === 'late' ? 'fixture.delayed'
          : command.op.startsWith('asset-') ? 'fixture.asset' : 'example.context-ready';
        const required = type === 'fixture.partial' ? 'fixture-partial' : type === 'fixture.delayed' ? 'fixture-late'
          : type === 'fixture.asset' ? 'fixture-asset' : 'operator-example';
        const assetId = command.op === 'asset-path' ? '/etc/passwd' : `${resourcePrefix}-${command.op === 'asset-wrong-scope' ? 'other-scope' : 'approved'}`;
        void host.engine.emit({ id: `fixture-${instance}-${command.id}`, type, conversationId: 'group:7001', data: {
          kind: 'operator-example', ...(type === 'fixture.asset' ? { assetId } : {}) } },
          { signal }).then(report => {
          try { assertRequiredEventOutcomes(report, [required]); record('command-confirmed', { id: command.id }); }
          catch (error) { record('command-rejected', { id: command.id, code: errorCode(error) }); }
        }, error => { record('command-rejected', { id: command.id, code: errorCode(error) }); });
      }, 10);
      timer.unref();
      record('started');
    },
    async stop(host, signal) {
      if (timer) clearInterval(timer);
      await base.stop?.(host, signal);
      record('stopped', { signalAborted: context.signal.aborted });
    }
  };
} });
