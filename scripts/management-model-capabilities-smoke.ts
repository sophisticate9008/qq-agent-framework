import assert from 'node:assert/strict';
import type { Locator, Page, Route } from 'playwright';
import { navigateConsolePage } from './browser-navigation-smoke.ts';

function gate() {
  let resolve = () => {};
  const promise = new Promise<void>(complete => { resolve = complete; });
  return { promise, resolve };
}

async function waitForGate(pending: ReturnType<typeof gate>, description: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), 30_000);
    void pending.promise.then(() => { clearTimeout(timeout); resolve(); });
  });
}

function field(editor: Locator, name: string): Locator {
  return editor.getByText(name, { exact: true }).locator('xpath=ancestor::label[1]').first();
}

interface HeldRead {
  readonly model: string;
  readonly entered: ReturnType<typeof gate>;
  readonly release: ReturnType<typeof gate>;
  readonly settled: ReturnType<typeof gate>;
}

export async function exerciseModelReasoningCapabilities(page: Page, requests: readonly { readonly method: string }[], providers: unknown): Promise<void> {
  let available = false;
  let hold: HeldRead | null = null;
  const heldReads: HeldRead[] = [];
  const plans = ['A', 'B'].map((suffix, index) => ({ id: `reasoning-${suffix.toLowerCase()}`, name: `Reasoning Fixture ${suffix}`,
    description: '', instructions: `Preserved instructions ${suffix}`, personaId: 'fixture-persona', provider: 'fixture-provider',
    model: index === 0 ? 'fixture-model' : 'fixture-model-v2', reasoningEffort: index === 0 ? 'high' : 'medium',
    contextLimits: { group: 172000, private: 384000 } }));
  const postsBefore = requests.filter(request => request.method === 'POST').length;
  const fulfillCapabilities = async (route: Route) => {
    const query = new URL(route.request().url()).searchParams;
    const provider = query.get('provider'); const model = query.get('model');
    assert.equal(provider, 'fixture-provider');
    const pending = hold?.model === model ? hold : null;
    if (pending) { hold = null; pending.entered.resolve(); await pending.release.promise; }
    try {
      await route.fulfill({ json: { provider, model, state: available ? 'available' : 'unavailable',
        reasoningEfforts: available ? model === 'fixture-model' ? ['off', 'high'] : ['off', 'medium'] : [],
        missingReasons: available ? [] : ['model_metadata_not_observed'] } });
    } catch (error) {
      // A switch cancels the old transport. Its deliberately late reply may
      // therefore be rejected by the browser rather than reach the component.
      if (!pending) throw error;
    } finally { pending?.settled.resolve(); }
  };
  await page.route('**/api/chat/plans', route => route.request().method() === 'GET'
    ? route.fulfill({ json: { revision: 'f'.repeat(64), activePlanId: plans[0].id, plans } }) : route.continue());
  await page.route('**/api/chat/providers', route => route.request().method() === 'GET'
    ? route.fulfill({ json: { revision: 'e'.repeat(64), providers } }) : route.continue());
  await page.route('**/api/chat/model-capabilities?*', fulfillCapabilities);
  try {
    await navigateConsolePage(page, 'overview');
    await navigateConsolePage(page, 'model');
    const editor = page.locator('#native-plan-editor');
    const reasoningField = field(editor, '思考强度');
    const reasoning = reasoningField.locator('select');
    const name = field(editor, '方案名称').locator('input');
    const instructions = field(editor, '方案指令').locator('textarea');
    const group = field(editor, '群聊上下文').locator('input');
    const model = field(editor, '模型').locator('select');
    await reasoningField.getByText(/没有读到与所选服务地址和模型匹配的能力声明/).waitFor();
    assert.equal(await reasoning.inputValue(), 'high');
    assert.equal(await reasoning.isDisabled(), true);
    assert.equal(await reasoning.locator('option[value="high"]').isDisabled(), true);
    assert.match(await reasoning.locator('option:checked').innerText(), /支持待核验/);
    assert.equal(await reasoning.locator('option[value="medium"]').count(), 0);

    available = true;
    await reasoningField.getByRole('button', { name: '重新读取支持情况', exact: true }).click();
    await reasoningField.getByText('当前模型支持：off、high。', { exact: true }).waitFor();
    assert.equal(await reasoning.isDisabled(), false);
    assert.equal(await reasoning.inputValue(), 'high');
    assert.deepEqual(await reasoning.locator('option:enabled').evaluateAll(elements => elements.map(element => (element as HTMLOptionElement).value)), ['off', 'high']);

    await page.getByRole('button', { name: /^Reasoning Fixture B/ }).click();
    await reasoningField.getByText('当前模型支持：off、medium。', { exact: true }).waitFor();
    assert.equal(await reasoning.inputValue(), 'medium');
    const delayNextFirstModel = () => {
      const pending = { model: 'fixture-model', entered: gate(), release: gate(), settled: gate() };
      heldReads.push(pending); hold = pending;
      return pending;
    };
    const oldPlan = delayNextFirstModel();
    const planRead = page.waitForRequest(request => new URL(request.url()).pathname === '/api/chat/model-capabilities'
      && new URL(request.url()).searchParams.get('model') === 'fixture-model');
    await page.getByRole('button', { name: /^Reasoning Fixture A/ }).click();
    await planRead;
    await waitForGate(oldPlan.entered, 'the held previous-plan capability route');
    await page.getByRole('button', { name: /^Reasoning Fixture B/ }).click();
    await reasoningField.getByText('当前模型支持：off、medium。', { exact: true }).waitFor();
    oldPlan.release.resolve(); await waitForGate(oldPlan.settled, 'the late previous-plan reply');
    assert.equal(await name.inputValue(), 'Reasoning Fixture B');
    assert.equal(await reasoning.inputValue(), 'medium');
    assert.equal(await reasoning.locator('option[value="high"]').count(), 0);

    await name.fill('Reasoning unsaved name');
    await instructions.fill('Reasoning unsaved instructions');
    await group.fill('177777');
    const oldModel = delayNextFirstModel();
    const modelRead = page.waitForRequest(request => new URL(request.url()).pathname === '/api/chat/model-capabilities'
      && new URL(request.url()).searchParams.get('model') === 'fixture-model');
    await model.selectOption('fixture-model'); await modelRead;
    await waitForGate(oldModel.entered, 'the held previous-model capability route');
    assert.equal(await reasoning.inputValue(), 'medium');
    assert.equal(await reasoning.isDisabled(), true);
    await model.selectOption('fixture-model-v2');
    await reasoningField.getByText('当前模型支持：off、medium。', { exact: true }).waitFor();
    oldModel.release.resolve(); await waitForGate(oldModel.settled, 'the late previous-model reply');
    assert.equal(await model.inputValue(), 'fixture-model-v2');
    assert.equal(await reasoning.inputValue(), 'medium');
    assert.equal(await reasoning.locator('option[value="high"]').count(), 0);
    assert.equal(await name.inputValue(), 'Reasoning unsaved name');
    assert.equal(await instructions.inputValue(), 'Reasoning unsaved instructions');
    assert.equal(await group.inputValue(), '177777');
    assert.equal(requests.filter(request => request.method === 'POST').length, postsBefore);
    await editor.getByRole('button', { name: '撤销更改', exact: true }).click();
    await navigateConsolePage(page, 'overview');
  } finally {
    for (const pending of heldReads) pending.release.resolve();
    await page.unroute('**/api/chat/plans');
    await page.unroute('**/api/chat/providers');
    await page.unroute('**/api/chat/model-capabilities?*', fulfillCapabilities);
  }
}
