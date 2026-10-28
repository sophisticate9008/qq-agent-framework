import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import type { AgentEvent, DurableStore } from '../src/contracts/ports.ts';
import type { JsonValue } from '../src/contracts/data.ts';
import type { PluginModelBackend } from '../src/contracts/plugin-model.ts';
import type { ImageGenerationService } from '../src/contracts/image-generation.ts';
import type { OneBotReadResult } from '../src/adapters/onebot-actions.ts';
import { createPluginModelService } from '../src/host/plugin-model-service.ts';
import { createPluginCapabilityService } from '../src/host/plugin-capability-service.ts';
import { createPluginSchedulerService } from '../src/host/plugin-scheduler.ts';
import { createPluginToolDirectory } from '../src/host/plugin-tool-directory.ts';
import { createSqliteStore } from '../src/storage/sqlite.ts';
import { createQzoneDiary, validateDiaryConfiguration } from '../plugins/qzone-diary/workflow.ts';
import { localDay, localMinute } from '../plugins/qzone-diary/time.ts';
import type { DiaryConfiguration, DiaryDay, DiaryMedia } from '../plugins/qzone-diary/types.ts';

const initial = Date.parse('2026-01-01T00:00:00Z');
const dayMs = 86_400_000;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCoYAAAAASUVORK5CYII=', 'base64');
const goodReview = { acceptable: true, captionMatches: true, issues: [] as string[], correction: '' };
type ModelStart = Parameters<PluginModelBackend['start']>[0];
type ImageRequest = Parameters<ImageGenerationService['generate']>[0];
interface FixtureOptions {
  readonly random?: () => number;
  readonly rejectImages?: number;
  readonly review?: (index: number) => unknown;
  readonly publish?: boolean;
  readonly outcome?: OneBotReadResult<JsonValue> | 'lost';
  readonly onReview?: (request: ModelStart, index: number) => void;
}

async function fixture(context: TestContext, options: FixtureOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'qaf-diary-'));
  const filename = join(directory, 'diary.sqlite');
  let now = initial;
  let configuration: DiaryConfiguration = { enabled: true, publish: options.publish ?? true, timeZone: 'Asia/Shanghai',
    persona: '测试角色喜欢散步、画画和有细节的生活记录。', model: { provider: 'fixture', model: 'writer' },
    visionModel: { provider: 'fixture', model: 'vision' }, windows: [{ start: 9 * 60, end: 12 * 60 },
      { start: 14 * 60, end: 17 * 60 }, { start: 19 * 60, end: 22 * 60 }] };
  const stats = { modelCalls: [] as ModelStart[], created: [] as Parameters<PluginModelBackend['create']>[0][],
    images: [] as ImageRequest[], publications: [] as unknown[], saved: [] as string[], pruned: [] as (readonly string[])[],
    order: [] as string[], planning: 0, reviews: 0, drafts: 0 };
  const remoteSessions = new Set<string>();
  const followers = new Map<string, (event: AgentEvent) => void | Promise<void>>();
  const backend: PluginModelBackend = {
    async models() { return ['writer', 'vision'].map(model => ({ provider: 'fixture', model, providerName: 'Fixture', modelName: model })); },
    async inspect(sessionId) { return { exists: remoteSessions.has(sessionId) }; },
    async create(request) { request.signal.throwIfAborted(); stats.created.push(request); remoteSessions.add(request.sessionId); },
    async follow(request) { const key = request.sessionId + ':' + request.requestId; followers.set(key, request.onEvent); return () => { followers.delete(key); }; },
    async start(request) {
      request.signal.throwIfAborted(); stats.modelCalls.push(request);
      let output: unknown;
      if (request.images?.length) {
        const index = stats.reviews++; stats.order.push('review'); options.onReview?.(request, index);
        assert.deepEqual(Buffer.from(request.images[0]!.data, 'base64'), png, 'Review must receive actual generated image bytes');
        output = options.review ? options.review(index) : index < (options.rejectImages ?? 0)
          ? { acceptable: false, captionMatches: true, issues: ['右手多出一根手指'], correction: '右手保留正常五根手指' } : goodReview;
      } else if (request.prompt.includes('"slots"')) {
        stats.planning++; stats.order.push('plan');
        const count = Number(request.prompt.match(/安排(\d+)个/)?.[1]);
        assert(count >= 1 && count <= 3);
        output = { slots: Array.from({ length: count }, (_, index) => ({ scene: `第${index + 1}段生活：去公园画树叶`, style: '柔和水彩' })) };
      } else {
        stats.drafts++; stats.order.push('draft');
        output = { caption: '下午在公园画了几片树叶，风把画纸吹得轻轻响。', prompt: '角色坐在公园长椅上画树叶，完整自然的双手，柔和水彩，没有文字水印。' };
      }
      const follow = followers.get(request.sessionId + ':' + request.requestId);
      assert(follow, 'Real model service must subscribe before submitting');
      await follow({ id: request.requestId + '-message', sessionId: request.sessionId, type: 'message', content: [{ type: 'text', text: JSON.stringify(output) }] });
      await follow({ id: request.requestId + '-completed', sessionId: request.sessionId, type: 'completed', data: { inputTokens: 10, outputTokens: 5 } });
      return { status: 'accepted' };
    },
    async waitForIdle() {},
    async inspectRun() { return { state: 'completed', idle: true, usage: {} }; },
  };
  const images: ImageGenerationService = { async generate(request) {
    request.signal.throwIfAborted(); stats.images.push(request); stats.order.push('image');
    assert.equal(request.subject, 'self');
    return { data: png, mediaType: 'image/png', sha256: createHash('sha256').update(png).digest('hex') };
  } };
  const media: DiaryMedia = {
    async save(id, image) { assert.deepEqual(image.data, png); stats.saved.push(id); return { id, protocolImage: 'base64://' + Buffer.from(image.data).toString('base64') }; },
    async prune(ids) { stats.pruned.push([...ids]); },
  };
  let store: DurableStore;
  let scheduler: ReturnType<typeof createPluginSchedulerService>;
  let diary: ReturnType<typeof createQzoneDiary>;
  let modelService: ReturnType<typeof createPluginModelService>;
  let lifetime: AbortController;
  function open() {
    store = createSqliteStore({ filename, clock: () => now });
    lifetime = new AbortController();
    scheduler = createPluginSchedulerService({ store, clock: () => now, intervalMs: 60_000, callbackTimeoutMs: 1000 });
    modelService = createPluginModelService({ store, backend, withSessionLease: (_id, _signal, operation) => operation() });
    const capabilities = createPluginCapabilityService({ store, accountId: 'fixture-account', port: {
      async inspect() { return { status: 'confirmed', data: { protocol: 'fixture', version: '1', source: 'reported-actions', supportedIds: ['send_qzone_msg'] } }; },
      async call(request) {
        request.signal.throwIfAborted(); stats.publications.push(request.input); stats.order.push('publish');
        assert.equal(request.id, 'send_qzone_msg');
        if (options.outcome === 'lost') throw new Error('Response connection lost after dispatch');
        return options.outcome ?? { status: 'confirmed', data: { tid: 'fixture-tid' } };
      },
    } });
    diary = createQzoneDiary({ store, runtime: {
      scheduler: scheduler.forPlugin('qzone-diary', lifetime.signal), models: modelService.forPlugin('qzone-diary', lifetime.signal),
      capabilities: capabilities.forPlugin('qzone-diary', lifetime.signal),
      sessions: { resolve() { assert.fail('Diary must use its independent binding'); },
        async bind() { assert.fail('Diary must not change QQ bindings'); }, async unbind() { assert.fail('Diary must not reset QQ sessions'); } },
    }, images, media, configuration: () => configuration, signal: lifetime.signal, clock: () => now, random: options.random ?? (() => 0) });
    diary.start(); scheduler.start();
  }
  async function stop() { lifetime.abort(); await scheduler.stop(); await diary.stop(); store.close(); }
  open();
  context.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  return {
    stats,
    get store() { return store; }, get diary() { return diary; }, get scheduler() { return scheduler; }, get models() { return modelService; },
    get now() { return now; }, get configuration() { return configuration; },
    configure(changes: Partial<DiaryConfiguration>) { configuration = { ...configuration, ...changes }; },
    setNow(value: number) { now = value; },
    async tick() { await scheduler.tick(); await scheduler.tick(); },
    async startPlan() { now += 5000; await scheduler.tick(); await scheduler.tick(); const result = diary.read(localDay(now, configuration.timeZone)); assert(result); return result; },
    async restart() { await stop(); open(); },
  };
}

for (const rejected of [0, 1, 2]) test(`a durable scheduled day publishes only after ${rejected} image regenerations and real image review`, async context => {
  const fixtureData = await fixture(context, { rejectImages: rejected });
  const day = await fixtureData.startPlan();
  assert.equal(day.state, 'planned'); assert.equal(day.slots.length, 1);
  const slot = day.slots[0]!;
  assert.equal(slot.state, 'scheduled');
  assert.equal(fixtureData.stats.images.length, 0); assert.equal(fixtureData.stats.publications.length, 0);
  fixtureData.setNow(slot.at); await fixtureData.tick();
  const result = fixtureData.diary.read(day.date)!.slots[0]!;
  assert.equal(result.state, 'published'); assert.equal(result.attempts, rejected + 1);
  assert.equal(fixtureData.stats.images.length, rejected + 1); assert.equal(fixtureData.stats.reviews, rejected + 1);
  assert.equal(fixtureData.stats.publications.length, 1);
  assert.deepEqual(fixtureData.stats.order, ['plan', 'draft', ...Array.from({ length: rejected + 1 }, () => ['image', 'review']).flat(), 'publish']);
  assert.equal(fixtureData.stats.modelCalls[0]!.sessionId, fixtureData.stats.modelCalls[1]!.sessionId);
  for (const image of fixtureData.stats.images.slice(1)) assert(image.prompt.includes('右手保留正常五根手指'));
  assert.equal(new Set(fixtureData.stats.images.map(image => image.idempotencyKey)).size, rejected + 1);
  const binding = fixtureData.models.listBindings('qzone-diary').find(binding => binding.name === 'diary');
  assert(binding); assert.equal(binding.conversationId, null);
  assert(fixtureData.stats.modelCalls[0]!.prompt.includes(fixtureData.configuration.persona));
  assert(!fixtureData.stats.modelCalls[1]!.prompt.includes(fixtureData.configuration.persona));
  const before = { calls: fixtureData.stats.modelCalls.length, images: fixtureData.stats.images.length, publishes: fixtureData.stats.publications.length };
  await fixtureData.restart(); await fixtureData.diary.planDay(); await fixtureData.tick(); await fixtureData.diary.publishSlot(day.date, 0);
  assert.deepEqual({ calls: fixtureData.stats.modelCalls.length, images: fixtureData.stats.images.length, publishes: fixtureData.stats.publications.length }, before);
  assert.equal(fixtureData.models.listBindings('qzone-diary')[0]!.sessionId, binding.sessionId);
});

test('three rejected image versions stop without a fourth generation or publication', async context => {
  const f = await fixture(context, { rejectImages: 3 });
  const day = await f.startPlan(); f.setNow(day.slots[0]!.at); await f.tick();
  assert.equal(f.diary.read(day.date)!.slots[0]!.state, 'skipped');
  assert.equal(f.diary.read(day.date)!.slots[0]!.error, 'DIARY_IMAGE_REJECTED');
  assert.equal(f.stats.images.length, 3); assert.equal(f.stats.reviews, 3); assert.equal(f.stats.publications.length, 0);
  await f.restart(); await f.tick(); assert.equal(f.stats.images.length, 3);
});

test('a caption mismatch or visible review issue cannot pass through an acceptable flag', async context => {
  const f = await fixture(context, { review: index => index === 0 ? { ...goodReview, captionMatches: false, correction: '文案与实际画面保持一致' }
    : index === 1 ? { ...goodReview, issues: ['画面手部连接错误'], correction: '重画手部连接' } : goodReview });
  const day = await f.startPlan(); f.setNow(day.slots[0]!.at); await f.tick();
  assert.equal(f.diary.read(day.date)!.slots[0]!.state, 'published');
  assert.equal(f.stats.images.length, 3); assert.equal(f.stats.publications.length, 1);
});

for (const outcome of ['lost', { status: 'unknown', code: 'FIXTURE_UNKNOWN' }, { status: 'rejected', code: 'FIXTURE_DENIED' }] as const)
  test(`publication ${typeof outcome === 'string' ? outcome : outcome.status} never becomes success or an automatic retry`, async context => {
    const f = await fixture(context, { outcome });
    const day = await f.startPlan(); f.setNow(day.slots[0]!.at); await f.tick();
    assert.equal(f.diary.read(day.date)!.slots[0]!.state, typeof outcome !== 'string' && outcome.status === 'rejected' ? 'skipped' : 'unknown');
    assert.equal(f.stats.publications.length, 1);
    const generated = f.stats.images.length;
    await f.restart(); await f.tick(); await f.diary.publishSlot(day.date, 0);
    assert.equal(f.stats.images.length, generated); assert.equal(f.stats.publications.length, 1);
  });

test('preview configuration completes review without calling the publication port', async context => {
  const f = await fixture(context, { publish: false });
  const day = await f.startPlan(); f.setNow(day.slots[0]!.at); await f.tick();
  assert.equal(f.diary.read(day.date)!.slots[0]!.state, 'preview');
  assert.equal(f.stats.images.length, 1); assert.equal(f.stats.reviews, 1); assert.equal(f.stats.publications.length, 0);
});

test('an approved preview can be explicitly published once after enabling the final write without generating again', async context => {
  const f = await fixture(context, { publish: false });
  const day = await f.startPlan(); f.setNow(day.slots[0]!.at); await f.tick();
  const models = f.stats.modelCalls.length;
  await assert.rejects(f.diary.publishApproved(day.date, 0), { code: 'DIARY_PUBLISH_NOT_READY' });
  assert.equal(f.stats.publications.length, 0);
  f.configure({ publish: true });
  await Promise.all([f.diary.publishApproved(day.date, 0), f.diary.publishApproved(day.date, 0)]);
  assert.equal(f.diary.read(day.date)!.slots[0]!.state, 'published');
  assert.equal(f.stats.publications.length, 1); assert.equal(f.stats.images.length, 1); assert.equal(f.stats.modelCalls.length, models);
});

test('current enabled and publication configuration are checked again after visual review', async context => {
  let change: (() => void) | undefined;
  const f = await fixture(context, { onReview() { change?.(); } });
  change = () => f.configure({ publish: false });
  const day = await f.startPlan(); f.setNow(day.slots[0]!.at); await f.tick();
  assert.equal(f.diary.read(day.date)!.slots[0]!.state, 'preview'); assert.equal(f.stats.publications.length, 0);
});

test('disabling or closing the time window during visual review prevents the final write', async context => {
  for (const reason of ['disabled', 'window-closed']) {
    let change: (() => void) | undefined;
    const f = await fixture(context, { onReview() { change?.(); } });
    const day = await f.startPlan();
    change = reason === 'disabled' ? () => f.configure({ enabled: false }) : () => f.setNow(day.slots[0]!.until);
    f.setNow(day.slots[0]!.at); await f.tick();
    assert.equal(f.diary.read(day.date)!.slots[0]!.state, 'skipped', reason);
    assert.equal(f.stats.publications.length, 0, reason);
  }
});

test('an invalid visual verdict becomes unresolved evidence without publishing or regenerating blindly', async context => {
  const f = await fixture(context, { review: () => ({ acceptable: true }) });
  const day = await f.startPlan(); f.setNow(day.slots[0]!.at); await f.tick();
  assert.equal(f.diary.read(day.date)!.slots[0]!.state, 'unknown');
  assert.equal(f.stats.images.length, 1); assert.equal(f.stats.publications.length, 0);
  await f.restart(); await f.tick(); assert.equal(f.stats.images.length, 1);
});

for (const count of [1, 2, 3]) test(`a saved daily plan contains ${count} random slots in distinct ordered local windows`, async context => {
  const randomValue = (count - 0.5) / 3;
  const f = await fixture(context, { random: () => randomValue });
  const day = await f.startPlan(); assert.equal(day.slots.length, count);
  for (const [index, slot] of day.slots.entries()) {
    const window = f.configuration.windows[index]!;
    assert(slot.at >= localMinute(day.date, window.start, f.configuration.timeZone));
    assert(slot.until === localMinute(day.date, window.end, f.configuration.timeZone));
    assert(slot.at + 1_800_000 <= slot.until);
    if (index > 0) assert(slot.at > day.slots[index - 1]!.until);
  }
  await f.restart(); await f.diary.planDay();
  assert.deepEqual(f.diary.read(day.date)!.slots.map(slot => slot.at), day.slots.map(slot => slot.at));
  assert.equal(f.stats.planning, 1);
});

test('restarting during the initial five-second planning delay preserves one durable startup trigger', async context => {
  const f = await fixture(context);
  f.setNow(initial + 1000); await f.restart();
  assert.equal(f.stats.planning, 0);
  f.setNow(initial + 5000); await f.tick();
  assert.equal(f.diary.read('2026-01-01')?.state, 'planned');
  assert.equal(f.stats.planning, 1);
  await f.restart(); await f.tick(); assert.equal(f.stats.planning, 1);
});

test('new daily plans reuse the independent durable writer binding and its initialized persona context', async context => {
  const f = await fixture(context);
  const first = await f.startPlan();
  const firstBinding = f.models.listBindings('qzone-diary')[0]!;
  await f.restart(); f.setNow(initial + dayMs + 30 * 60_000); await f.tick();
  const next = f.diary.read('2026-01-02'); assert(next); assert.equal(next.state, 'planned');
  assert.equal(f.stats.planning, 2); assert.notEqual(next.date, first.date);
  assert.equal(f.models.listBindings('qzone-diary')[0]!.sessionId, firstBinding.sessionId);
  const plans = f.stats.modelCalls.filter(request => request.prompt.includes('"slots"'));
  assert(plans[0]!.prompt.includes(f.configuration.persona));
  assert(!plans[1]!.prompt.includes(f.configuration.persona));
  assert.equal(f.stats.created.filter(request => request.model.model === 'writer').length, 1);
});

test('missed windows do not generate or publish and terminal days and unused media are retained for seven days', async context => {
  const f = await fixture(context);
  const day = await f.startPlan(); f.setNow(day.slots[0]!.until); await f.tick(); await f.diary.maintain();
  assert.equal(f.diary.read(day.date)!.slots[0]!.state, 'skipped');
  assert.equal(f.stats.images.length, 0); assert.equal(f.stats.publications.length, 0);
  f.setNow(initial + 6 * dayMs); await f.diary.maintain(); assert(f.diary.read(day.date));
  f.setNow(initial + 8 * dayMs); await f.diary.maintain(); assert.equal(f.diary.read(day.date), null);
  assert.deepEqual(f.stats.pruned.at(-1), []);
});

for (const state of ['generating', 'reviewing', 'publishing'] as const) test(`interrupted ${state} slots retain unknown evidence and artifacts without automatic resume`, async context => {
  const f = await fixture(context);
  const day = await f.startPlan();
  const interrupted: DiaryDay = { ...day, slots: day.slots.map(slot => ({ ...slot, state, attempts: 1, artifactId: 'keep-interrupted-image' })) };
  const record = f.store.read('qzone-diary.days', day.date)!;
  f.store.write('qzone-diary.days', day.date, interrupted as unknown as JsonValue, { expectedRevision: record.revision });
  await f.restart();
  assert.equal(f.diary.read(day.date)!.slots[0]!.state, 'unknown');
  f.setNow(initial + 8 * dayMs); await f.diary.maintain();
  assert(f.diary.read(day.date)); assert(f.stats.pruned.at(-1)?.includes('keep-interrupted-image'));
  assert.equal(f.stats.images.length, 0); assert.equal(f.stats.publications.length, 0);
});

test('an interrupted daily planning intent remains unknown across startup and ordinary retention', async context => {
  const f = await fixture(context);
  const interrupted: DiaryDay = { date: '2026-01-01', state: 'planning', createdAt: initial, updatedAt: initial, slots: [] };
  f.store.write('qzone-diary.days', interrupted.date, interrupted as unknown as JsonValue, { expectedRevision: null });
  await f.restart(); f.setNow(initial + 5000); await f.tick();
  assert.equal(f.diary.read(interrupted.date)!.state, 'unknown'); assert.equal(f.stats.planning, 0);
  f.setNow(initial + 8 * dayMs); await f.diary.maintain();
  assert(f.diary.read(interrupted.date)); assert.equal(f.stats.images.length, 0); assert.equal(f.stats.publications.length, 0);
});

test('configuration rejects overlapping windows and local time conversion preserves the requested day', () => {
  assert.equal(localDay(Date.parse('2026-01-01T16:00:00Z'), 'Asia/Shanghai'), '2026-01-02');
  assert.equal(localMinute('2026-01-02', 0, 'Asia/Shanghai'), Date.parse('2026-01-01T16:00:00Z'));
  assert.throws(() => localMinute('2026-03-08', 2 * 60 + 30, 'America/New_York'), /DIARY_LOCAL_TIME_UNAVAILABLE/);
  const configuration: DiaryConfiguration = { enabled: true, publish: false, timeZone: 'UTC', persona: '角色',
    model: { provider: 'fixture', model: 'writer' }, visionModel: { provider: 'fixture', model: 'vision' },
    windows: [{ start: 540, end: 720 }, { start: 700, end: 900 }] };
  assert.throws(() => validateDiaryConfiguration(configuration), { code: 'DIARY_WINDOWS_INVALID' });
});

for (const [now, date, expectedEnd] of [
  ['2026-03-08T20:00:00Z', '2026-03-08', '2026-03-09T04:00:00Z'],
  ['2026-11-01T20:00:00Z', '2026-11-01', '2026-11-02T05:00:00Z'],
] as const) test(`a midnight-ending window follows the actual local day across DST on ${date}`, async context => {
  const f = await fixture(context);
  f.configure({ timeZone: 'America/New_York', windows: [{ start: 21 * 60, end: 1440 }] });
  f.setNow(Date.parse(now)); await f.diary.planDay();
  const day = f.diary.read(date); assert(day);
  assert.equal(day.slots[0]!.until, Date.parse(expectedEnd));
});

test('an extension directory write returning unknown keeps its durable barrier beyond ordinary retention', async context => {
  let now = Date.now();
  const store = createSqliteStore({ filename: ':memory:', clock: () => now });
  context.after(() => store.close());
  const tools = createPluginToolDirectory({ store });
  let calls = 0;
  tools.forPlugin('qzone-diary', new AbortController().signal).register({ id: 'uncertain-publication',
    description: 'Local unknown publication receipt fixture', permission: 'owner', readOnly: false,
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute() { calls++; return { status: 'unknown', retry: false }; } });
  const request = { input: {}, signal: new AbortController().signal,
    scope: { eventId: 'same-publication', conversationId: 'private:123', featureId: 'framework-tools', version: '1.0.0' } };
  const effect = tools.entries()[0]!.effect;
  await effect.execute(request); await effect.execute(request);
  const record = store.list('plugin-tool.invocations')[0]!;
  assert(record.value && typeof record.value === 'object' && !Array.isArray(record.value));
  assert.equal(record.value.status, 'unknown'); assert.equal(record.expiresAt, null); assert.equal(calls, 1);
  now += 8 * dayMs; store.purgeExpired();
  await effect.execute(request); assert.equal(calls, 1);
});
