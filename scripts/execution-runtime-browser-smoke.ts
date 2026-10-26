import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { asRecord } from '../web/lib/api.ts';

export async function verifyExecutionThemes(page: Page, origin: string, capture: (label: string) => Promise<void>): Promise<Readonly<Record<string, boolean | number | string>>> {
  const evidence: Record<string, boolean | number | string> = {};
  const selectors = { sessions: '#execution-journal', settings: '#chat-execution', authorization: '#chat-authorization', runtime: '#chat-runtime', bootstrap: '#native-bootstrap-summary', features: '[data-page="features"] .panel' };
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const [view, selector] of Object.entries(selectors)) {
      await page.goto(`${origin}/test/fixtures/execution-runtime.html?view=${view}&layoutLarge=1`);
      if (view === 'sessions') {
        await page.locator('[data-execution-journal] > summary').click();
        await page.locator('[data-execution-row]').first().waitFor();
      } else if (view === 'settings') {
        await page.locator('#execution-turn-seconds').waitFor();
        await page.getByText('高级：并行数与确认期限', { exact: true }).click();
      } else if (view === 'authorization') {
        await page.getByText('高级：旧模式授权与次数', { exact: true }).click();
        await page.getByRole('textbox', { name: '群号', exact: true }).waitFor();
        await page.locator('#runtime-fixture-source-b').click();
        await page.getByText('高级：旧模式授权与次数', { exact: true }).click();
        await page.getByRole('spinbutton', { name: /超时停止请求次数/ }).waitFor();
      }
      else if (view === 'bootstrap') { await page.locator('[data-native-bootstrap-summary] > summary').click(); await page.locator('[data-bootstrap-feature="0"]').waitFor(); }
      else if (view === 'features') { await page.getByRole('tab', { name: 'Agent 扩展', exact: true }).click(); await page.getByText('合成功能 A 0', { exact: true }).waitFor(); }
      else await page.getByRole('button', { name: '刷新状态', exact: true }).waitFor();
      const colors: string[] = [];
      for (const theme of ['light', 'dark']) {
        await page.getByRole('combobox', { name: '隔离显示模式', exact: true }).selectOption(theme);
        await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
        await page.waitForTimeout(180);
        const measured = await page.locator(selector).first().evaluate(element => {
          const style = getComputedStyle(element);
          const canvas = document.createElement('canvas');
          canvas.width = 1; canvas.height = 1;
          const context = canvas.getContext('2d');
          if (!context) throw new Error('theme_color_measurement_unavailable');
          const luminance = (channels: Uint8ClampedArray) => [0.2126, 0.7152, 0.0722].reduce((sum, weight, index) => {
            const channel = channels[index]! / 255;
            return sum + weight * (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
          }, 0);
          const contrast = (target: Element) => {
            context.fillStyle = 'white'; context.fillRect(0, 0, 1, 1);
            const ancestors: Element[] = [];
            for (let ancestor: Element | null = target; ancestor; ancestor = ancestor.parentElement) ancestors.unshift(ancestor);
            for (const ancestor of ancestors) { context.fillStyle = getComputedStyle(ancestor).backgroundColor; context.fillRect(0, 0, 1, 1); }
            const background = luminance(context.getImageData(0, 0, 1, 1).data);
            context.fillStyle = getComputedStyle(target).color; context.fillRect(0, 0, 1, 1);
            const foreground = luminance(context.getImageData(0, 0, 1, 1).data);
            return (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05);
          };
          const fields = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('section input:enabled:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]), section textarea:enabled')]
            .filter(input => input.getClientRects().length > 0 && input.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }))
            .map(input => ({ label: input.closest('label')?.textContent?.trim().slice(0, 80), type: input.type,
              foreground: getComputedStyle(input).color, background: getComputedStyle(input).backgroundColor,
              contrast: contrast(input), font: Number.parseFloat(getComputedStyle(input).fontSize), width: input.getBoundingClientRect().width }));
          return { background: style.backgroundColor, foreground: style.color, colorScheme: getComputedStyle(document.documentElement).colorScheme,
            contrast: contrast(element), fields, viewport: innerWidth, documentWidth: document.documentElement.scrollWidth };
        });
        assert.equal(measured.colorScheme, theme);
        assert.ok(measured.documentWidth <= measured.viewport + 1, JSON.stringify({ view, width, theme, measured }));
        assert.ok(measured.contrast >= 4.5, JSON.stringify({ view, width, theme, measured }));
        for (const field of measured.fields) assert.ok(field.contrast >= 4.5 && field.font >= 12 && field.width > 32 && field.width <= width, JSON.stringify({ view, width, theme, field }));
        if (view === 'sessions' || view === 'settings') assert.ok(measured.fields.length > 0);
        colors.push(`${measured.background}/${measured.foreground}`);
        evidence[`${view}-${width}-${theme}-colors`] = colors.at(-1)!;
        evidence[`${view}-${width}-${theme}-minimumContrast`] = Math.min(measured.contrast, ...measured.fields.map(field => field.contrast));
        const regions = view === 'sessions' ? ['[data-execution-journal-scroll]']
          : view === 'bootstrap' ? ['[data-bootstrap-summary-scroll]'] : view === 'features' ? ['[aria-label="功能清单"]'] : [`${selector} [data-bounded-card]`];
        for (const region of regions) {
          const dimensions = await page.locator(region).evaluate(element => {
            element.scrollTop = element.scrollHeight;
            return { height: element.getBoundingClientRect().height, scroll: element.scrollHeight, position: element.scrollTop, overflow: getComputedStyle(element).overflowY };
          });
          assert.ok(dimensions.height >= 254 && dimensions.height <= 385 && dimensions.overflow === 'auto', JSON.stringify({ view, width, theme, dimensions }));
          if (view === 'sessions' || view === 'features') assert.ok(dimensions.scroll > dimensions.height && dimensions.position > 0, JSON.stringify(dimensions));
        }
        await page.waitForTimeout(100);
        if (view === 'sessions') {
          await page.locator('[data-execution-row="99"]').waitFor();
          assert.equal(await page.locator('[data-execution-detail] details[open], #native-bootstrap-summary details[open]:not([data-native-bootstrap-summary])').count(), 0);
        }
        if (view === 'features') {
          await page.getByText('合成功能 A 319', { exact: true }).waitFor();
          assert.equal(await page.locator('[data-page="features"] details[open]').count(), 0);
        }
        await capture(`theme-${view}-${width}-${theme}`);
      }
      assert.notEqual(colors[0], colors[1], `${view}/${width}: theme colors did not change`);
    }
  }
  evidence.actualThemeProviderLightDark390And1440 = true;
  evidence.fixedHeightInnerScrollFoldedIdentifiersAndReadableInputs = true;
  return evidence;
}

export async function verifyExecutionRuntimeUi(page: Page, origin: string, capture: (label: string) => Promise<void> = async () => {}): Promise<Readonly<Record<string, boolean | number>>> {
  const evidence: Record<string, boolean | number> = {};
  const showFeatureSettings = async () => {
    if (!new URL(page.url()).searchParams.get('view')?.startsWith('features')) return;
    const tab = page.getByRole('tab', { name: 'Agent 扩展', exact: true });
    await tab.click();
    await tab.and(page.locator('[aria-selected="true"]')).waitFor();
    await page.getByRole('tabpanel').filter({ has: page.locator('#native-bootstrap-summary') }).waitFor();
  };
  const open = async (view: string) => { await page.goto(`${origin}/test/fixtures/execution-runtime.html?view=${view}`); if (view.startsWith('features')) await showFeatureSettings(); if (view === 'authorization') await page.getByText('高级：旧模式授权与次数', { exact: true }).click(); };
  const pending = (count: number) => page.waitForFunction(count => document.querySelector('#runtime-fixture-state')?.getAttribute('data-pending') === String(count), count);
  const writeCount = async () => Number(await page.locator('#runtime-fixture-state').getAttribute('data-writes'));
  const noWrites = async () => assert.equal(await writeCount(), 0);
  const inputValue = (selector: string, value: string) => page.waitForFunction(({ selector, value }) => document.querySelector<HTMLInputElement>(selector)?.value === value, { selector, value });
  const lastWrite = async () => asRecord(JSON.parse(await page.locator('#runtime-fixture-state').getAttribute('data-last-write') ?? '{}') as unknown);
  const latestPolicy = async () => asRecord(asRecord((await lastWrite()).body).policy);
  const latestGrant = async () => {
    const entries = asRecord((await lastWrite()).body).grants;
    assert(Array.isArray(entries) && entries.length === 1);
    return asRecord(entries[0]);
  };
  const bootstrap = page.locator('#native-bootstrap-summary');
  const readBootstrap = () => bootstrap.getByRole('button', { name: '重新读取扩展摘要', exact: true }).click();
  const openBootstrap = async () => {
    await open('bootstrap');
    await page.locator('[data-native-bootstrap-summary] > summary').click();
    await page.locator('[data-bootstrap-feature="0"]').waitFor();
  };
  await openBootstrap();
  const visible = await bootstrap.innerText();
  assert.match(visible, /未受沙箱隔离/);
  assert.match(visible, /安装器没有创建授权/);
  assert.match(visible, /不代表当前启用或授权/);
  assert.equal(visible.includes('isolated-feature-0'), false);
  assert.equal(visible.includes('bbbbbbbbbbbbbbbbbbbbbbbb'), false);
  assert.equal(await bootstrap.locator('input, textarea, select').count(), 0);
  assert.equal(await bootstrap.getByRole('button').filter({ hasText: /安装|启动扩展|授权|编辑路径/ }).count(), 0);
  await bootstrap.getByText('装配清单与代码指纹（按需展开复制）', { exact: true }).click();
  await bootstrap.getByRole('button', { name: '复制代码指纹', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#native-bootstrap-summary')?.textContent?.includes('已复制代码指纹'));
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'b'.repeat(64));
  assert.match(await bootstrap.innerText(), /不是依赖签名.*授权证明/);
  evidence.bootstrapReadonlyHumanBoundaryAndFoldedCopy = true;
  for (const [mode, expected] of [
    ['not-started', '尚无挂载详情'], ['unsettled-create', '扩展生命周期仍未结束，结果未知'],
    ['unknown', '扩展生命周期结果未知'], ['pending-stop', '停止仍待确认'],
    ['null', '当前宿主未配置运维选择的可信扩展'], ['missing', '当前服务没有提供可信扩展摘要'],
  ] as const) {
    await page.locator(`#runtime-fixture-bootstrap-${mode}`).click();
    await readBootstrap();
    await page.waitForFunction(expected => document.querySelector('#native-bootstrap-summary')?.textContent?.includes(expected), expected);
    if (mode === 'not-started' || mode === 'unsettled-create') {
      assert.equal(await page.locator('[data-bootstrap-feature]').count(), 0);
      assert.match(await bootstrap.innerText(), /均未读取.*不能当作零项/);
    }
    await noWrites();
  }
  evidence.bootstrapMissingPartialUnknownAndPendingNeverZeroOrReady = true;
  await page.locator('#runtime-fixture-bootstrap-running').click();
  await page.locator('#runtime-fixture-large').click();
  await readBootstrap();
  await page.waitForFunction(() => document.querySelector('#native-bootstrap-summary')?.textContent?.includes('64 项'));
  let maxFeatures = 0;
  for (const fraction of [0, 0.4, 0.8, 1, 1]) {
    await page.locator('[data-bootstrap-summary-scroll]').evaluate((element, fraction) => { element.scrollTop = (element.scrollHeight - element.clientHeight) * fraction; }, fraction);
    await page.waitForTimeout(70);
    const count = await page.locator('[data-bootstrap-feature]').count();
    assert.ok(count > 0 && count < 40, String(count));
    maxFeatures = Math.max(maxFeatures, count);
  }
  await page.locator('[data-bootstrap-feature="63"]').waitFor();
  assert.equal(await page.locator('[data-bootstrap-summary-scroll]').evaluate(element => element.clientHeight), 382);
  evidence.bootstrapFeatures = 64;
  evidence.bootstrapMaxMountedFeatures = maxFeatures;
  evidence.bootstrapFixedHeightVirtualEnd = true;
  await capture('bootstrap-summary');

  for (const completion of ['resolve', 'reject']) {
    await openBootstrap();
    await page.locator('#runtime-fixture-hold-read').click();
    await readBootstrap();
    await pending(1);
    await page.locator('#runtime-fixture-disconnect').click();
    await page.locator('#runtime-fixture-source-b').click();
    await page.locator('#runtime-fixture-hold-read').click();
    await page.locator('#runtime-fixture-connect').click();
    await showFeatureSettings();
    await pending(2);
    await page.locator(`#runtime-fixture-${completion}`).click();
    await pending(1);
    assert.equal(await bootstrap.getByRole('button', { name: '重新读取扩展摘要', exact: true }).isDisabled(), true);
    assert.equal(await bootstrap.locator('[role="alert"]').count(), 0);
    await page.locator('#runtime-fixture-resolve').click();
    await pending(0);
    await page.waitForFunction(() => document.querySelector('#native-bootstrap-summary')?.textContent?.includes('扩展版本 2.0.0'));
    await noWrites();
  }
  evidence.bootstrapOldApiSuccessFailureFinallyCannotReplaceNewRead = true;
  await open('features');
  await page.locator('[data-page="features"]').waitFor();
  await page.locator('[data-native-bootstrap-summary] > summary').click();
  await page.locator('[data-bootstrap-feature="0"]').waitFor();
  assert.equal(await page.locator('#native-bootstrap-summary input, #native-bootstrap-summary textarea, #native-bootstrap-summary select').count(), 0);
  await noWrites();
  evidence.bootstrapReachableInActualFeatures = true;
  await capture('features-bootstrap-summary');

  const settings = page.locator('#chat-execution');
  const saveSettings = () => settings.getByRole('button', { name: '保存处理策略', exact: true }).click();
  const readSettings = () => settings.getByRole('button', { name: '重新读取策略', exact: true }).click();
  const openSettings = async () => { await open('settings'); await inputValue('#execution-turn-seconds', '60'); };
  await openSettings();
  await settings.getByText('高级：并行数与确认期限', { exact: true }).click();
  await page.locator('#execution-turn-seconds').fill('60.001');
  await page.locator('#execution-notice-text').fill('合成提醒：关闭后仍须原样保留');
  await page.locator('#execution-cancel-seconds').fill('1.001');
  await page.locator('#execution-notice-seconds').fill('0.029');
  await settings.getByRole('switch', { name: '超时后发送提醒', exact: true }).click();
  await settings.getByRole('switch', { name: '请求停止超时任务', exact: true }).click();
  assert.equal(await page.locator('#execution-notice-text').count(), 0);
  assert.equal(await page.locator('#execution-cancel-seconds').count(), 0);
  assert.equal(await page.locator('#execution-notice-seconds').count(), 0);
  await saveSettings();
  await page.waitForFunction(() => document.querySelector('#chat-execution')?.textContent?.includes('处理策略已保存'));
  const policy = await latestPolicy();
  assert.equal(policy.turnTimeoutMs, 60_001);
  assert.equal(policy.cancelTimeoutMs, 1001);
  assert.equal(policy.noticeTimeoutMs, 29);
  assert.equal(policy.noticeText, '合成提醒：关闭后仍须原样保留');
  assert.equal(policy.noticeEnabled, false);
  assert.equal(policy.cancelOnTimeout, false);
  assert.equal(Object.hasOwn(asRecord((await lastWrite()).body), 'grants'), false);
  assert.equal(asRecord((await lastWrite()).body).revision, 'a'.repeat(64));
  await settings.getByRole('switch', { name: '超时后发送提醒', exact: true }).click();
  await settings.getByRole('switch', { name: '请求停止超时任务', exact: true }).click();
  assert.equal(await page.locator('#execution-notice-text').inputValue(), policy.noticeText);
  assert.equal(await page.locator('#execution-cancel-seconds').inputValue(), '1.001');
  assert.equal(await page.locator('#execution-notice-seconds').inputValue(), '0.029');
  evidence.default60ExactMillisecondsAndHiddenDraftValuesPreserved = true;
  await capture('execution-settings');

  await openSettings();
  await page.locator('#execution-turn-seconds').fill('61');
  await readSettings();
  await page.waitForFunction(() => document.querySelector('#execution-turn-seconds')?.hasAttribute('disabled') === false);
  assert.equal(await page.locator('#execution-turn-seconds').inputValue(), '61');
  await settings.getByRole('button', { name: '撤销更改', exact: true }).click();
  await inputValue('#execution-turn-seconds', '60');
  await noWrites();
  evidence.executionReadPreservesDraftAndExplicitUndoAdoptsSaved = true;
  for (const mode of ['conflict', 'unknown']) {
    await openSettings();
    await page.locator('#execution-turn-seconds').fill('61');
    await page.locator(`#runtime-fixture-${mode}`).click();
    await saveSettings();
    await settings.locator('[role="alert"]').waitFor();
    assert.equal(await page.locator('#execution-turn-seconds').isDisabled(), true);
    assert.equal(await settings.getByRole('button', { name: '保存处理策略', exact: true }).isDisabled(), true);
    assert.equal(await writeCount(), 1);
    await page.waitForTimeout(80);
    assert.equal(await writeCount(), 1);
    await readSettings();
    await settings.getByRole('button', { name: '已核对，允许新的保存', exact: true }).click();
    if (mode === 'conflict') await settings.getByRole('button', { name: '撤销更改', exact: true }).click();
    await inputValue('#execution-turn-seconds', mode === 'unknown' ? '61' : '60');
    assert.equal(await writeCount(), 1);
  }
  evidence.cas409And504FreezeWithoutRetryOrImplicitGrant = true;

  for (const completion of ['resolve', 'reject']) {
    await openSettings();
    await page.locator('#runtime-fixture-hold-read').click();
    await readSettings();
    await pending(1);
    await page.locator('#runtime-fixture-disconnect').click();
    await page.locator('#runtime-fixture-source-b').click();
    await page.locator('#runtime-fixture-hold-read').click();
    await page.locator('#runtime-fixture-connect').click();
    await showFeatureSettings();
    await pending(2);
    await page.locator(`#runtime-fixture-${completion}`).click();
    await pending(1);
    assert.equal(await settings.getByRole('button', { name: '重新读取策略', exact: true }).isDisabled(), true);
    assert.equal(await page.locator('#execution-turn-seconds').count(), 0);
    await page.locator('#runtime-fixture-resolve').click();
    await pending(0);
    await inputValue('#execution-turn-seconds', '90');
    assert.equal(await settings.locator('[role="alert"]').count(), 0);
  }
  evidence.settingsOldApiGetSuccessFailureFinallyCannotReplaceNewRead = true;
  for (const completion of ['resolve', 'reject']) {
    await openSettings();
    await page.locator('#execution-turn-seconds').fill('61');
    await page.locator('#runtime-fixture-hold-write').click();
    await saveSettings();
    await pending(1);
    await page.locator('#runtime-fixture-disconnect').click();
    await page.locator('#runtime-fixture-source-b').click();
    await page.locator('#runtime-fixture-connect').click();
    await showFeatureSettings();
    await inputValue('#execution-turn-seconds', '90');
    await page.locator('#execution-turn-seconds').fill('92');
    await page.locator('#runtime-fixture-hold-write').click();
    await saveSettings();
    await pending(2);
    await page.locator(`#runtime-fixture-${completion}`).click();
    await pending(1);
    assert.equal(await page.locator('#execution-turn-seconds').inputValue(), '92');
    assert.equal(await page.locator('#execution-turn-seconds').isDisabled(), true);
    assert.equal(await settings.getByRole('button', { name: '正在保存', exact: true }).isDisabled(), true);
    assert.equal(await settings.locator('[role="alert"]').count(), 0);
    assert.equal((await lastWrite()).source, 'B');
    assert.equal(asRecord((await lastWrite()).body).revision, 'b'.repeat(64));
    await page.locator('#runtime-fixture-resolve').click();
    await pending(0);
    await page.waitForFunction(() => document.querySelector('#chat-execution')?.textContent?.includes('处理策略已保存'));
    assert.equal(await writeCount(), 2);
    assert.equal(await page.locator('#execution-turn-seconds').isDisabled(), false);
    assert.ok(Number(await page.locator('#runtime-fixture-state').getAttribute('data-aborted')) > 0);
  }
  evidence.settingsOldApiPostSuccessFailureFinallyCannotUnlockNewSave = true;

  const grants = page.locator('#chat-authorization');
  const saveGrants = async () => { await grants.getByRole('checkbox').check(); await grants.getByRole('button', { name: '保存新授权', exact: true }).click(); await page.waitForFunction(() => document.body.textContent?.includes('授权已保存')); };
  await open('authorization');
  await grants.getByRole('spinbutton', { name: '模型提交次数', exact: true }).waitFor();
  assert.equal(await grants.getByRole('spinbutton', { name: /超时停止请求次数/ }).count(), 0);
  await grants.getByRole('spinbutton', { name: '回复发送次数', exact: true }).fill('8');
  await saveGrants();
  const legacy = await latestGrant();
  assert.equal(Object.hasOwn(legacy, 'cancelUses'), false);
  assert.equal(legacy.submitUses, 7);
  assert.equal(legacy.sendUses, 8);
  await open('authorization');
  await grants.getByRole('spinbutton', { name: '模型提交次数', exact: true }).waitFor();
  await page.locator('#runtime-fixture-cancel-enabled').click();
  await grants.getByRole('button', { name: '重新读取', exact: true }).click();
  const cancel = grants.getByRole('spinbutton', { name: /超时停止请求次数/ });
  await cancel.waitFor();
  assert.equal(await cancel.inputValue(), '0');
  assert.equal(await writeCount(), 0);
  const dirtyScopes = asRecord(JSON.parse(await page.locator('#runtime-fixture-state').getAttribute('data-dirty') ?? '{}') as unknown);
  assert.equal(dirtyScopes['chat-authorization'], false);
  assert.match(await grants.innerText(), /上限不代表剩余次数，重启不补额/);
  await grants.getByRole('spinbutton', { name: '回复发送次数', exact: true }).fill('8');
  await saveGrants();
  const zero = await latestGrant();
  assert.equal(zero.cancelUses ?? 0, 0);
  assert.notEqual(asRecord((await lastWrite()).body).version, 'fixture-A');
  await cancel.fill('4');
  await saveGrants();
  const independent = await latestGrant();
  assert.equal(independent.cancelUses, 4);
  assert.equal(independent.submitUses, 7);
  assert.equal(independent.sendUses, 8);
  evidence.cancelCapabilityAndIndependentBudgetNoLegacyPositiveUpgrade = true;
  await capture('authorization');

  for (const [code, text] of [
    ['NATIVE_CHAT_CORRELATION_PLUGIN_UNAVAILABLE', '插件'],
    ['NATIVE_CHAT_PERSONA_VERSION_MIGRATION_REQUIRED', '显式迁移'],
    ['NATIVE_CHAT_SESSION_CONFIGURATION_CONFLICT', '保留上下文'],
  ] as const) {
    await open('runtime');
    await page.getByRole('button', { name: '刷新状态', exact: true }).waitFor();
    await page.locator(`#runtime-fixture-error-${code}`).click();
    await page.getByRole('button', { name: '刷新状态', exact: true }).click();
    await page.waitForFunction(text => document.querySelector('#chat-runtime')?.textContent?.includes(text), text);
    await page.locator('#chat-runtime').getByText('启动检查说明', { exact: true }).click();
    const content = await page.locator('#chat-runtime').innerText();
    assert.equal(content.includes(code), false);
    assert.match(content, /启动检查仅核对连接和配置，不发送模型请求/);
    await noWrites();
  }
  evidence.runtimeMissingPluginAndMigrationProtectHistory = true;
  await capture('runtime-diagnostics');
  for (const completion of ['resolve', 'reject']) {
    await open('journal');
    await page.locator('[data-execution-journal] > summary').click();
    await page.locator('[data-execution-row]').waitFor();
    await page.locator('#runtime-fixture-hold-read').click();
    await page.locator('#execution-journal').getByRole('button', { name: '重新读取日志', exact: true }).click();
    await pending(1);
    await page.locator('#runtime-fixture-disconnect').click();
    await page.locator('#runtime-fixture-source-b').click();
    await page.locator('#runtime-fixture-hold-read').click();
    await page.locator('#runtime-fixture-connect').click();
    await showFeatureSettings();
    await pending(2);
    await page.locator(`#runtime-fixture-${completion}`).click();
    await pending(1);
    assert.equal(await page.locator('#execution-journal').getByRole('button', { name: '重新读取日志', exact: true }).isDisabled(), true);
    assert.equal(await page.locator('#execution-journal [role="alert"]').count(), 0);
    await page.locator('#runtime-fixture-resolve').click();
    await pending(0);
    await page.waitForFunction(() => document.querySelector('[data-execution-detail]')?.textContent?.includes('200000'));
    await noWrites();
  }
  evidence.journalApiSwapOldSuccessFailureFinallyCannotReplaceNewRead = true;
  await open('features');
  await page.getByText('合成功能 A 0', { exact: true }).waitFor();
  const featureRegion = page.getByRole('region', { name: '功能清单', exact: true, includeHidden: true });
  const toolStatus = page.locator('#native-tool-runtime');
  const layoutFrames = () => page.evaluate(() => new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  for (const offset of [1400, 0]) {
    await featureRegion.evaluate((element, offset) => { element.scrollTop = offset; }, offset);
    await layoutFrames();
    const visibleHeight = await featureRegion.getByRole('list', { exact: true }).evaluate(element => element.scrollHeight);
    await page.getByRole('tab', { name: '框架内置', exact: true }).click();
    await toolStatus.getByText('当前运行快照没有已装配的功能包。', { exact: true }).waitFor();
    await toolStatus.getByText('框架工具通道尚未接入。请在连接页检查 DSH 工具通道。', { exact: true }).waitFor();
    assert.equal(await toolStatus.getByRole('button', { name: '管理主人与白名单', exact: true }).count(), 1);
    await featureRegion.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.querySelector('[aria-label="功能清单"]')?.querySelectorAll('[data-virtual-index]').length === 0);
    await layoutFrames();
    const hidden = await featureRegion.evaluate(element => ({
      height: element.getBoundingClientRect().height,
      total: [...element.querySelectorAll<HTMLElement>('[data-virtual-spacer]')]
        .reduce((total, spacer) => total + Number.parseFloat(spacer.style.height), 0),
    }));
    assert.equal(hidden.height, 0);
    assert.ok(Math.abs(hidden.total - visibleHeight) <= 1, JSON.stringify({ offset, visibleHeight, hidden }));
    await showFeatureSettings();
    await featureRegion.evaluate((element, offset) => { element.scrollTop = offset; }, offset);
    await layoutFrames();
    assert.ok(Math.abs(await featureRegion.evaluate(element => element.scrollTop) - offset) <= 1);
  }
  evidence.featuresHiddenTabPreservesMeasuredGeometryAtTopAndMiddle = true;
  await page.getByText('合成功能 A 0', { exact: true }).waitFor();
  await featureRegion.getByText('状态待确认', { exact: true }).waitFor();
  const featureVisible = await page.locator('[data-page="features"]').innerText();
  for (const identifier of ['chat-plans', 'model-settings', 'access-policy', 'fixture.feature-0', 'fixture.capability-4']) assert.equal(featureVisible.includes(identifier), false);
  assert.match(featureVisible, /扩展功能/);
  assert.match(featureVisible, /运行中/);
  assert.match(featureVisible, /状态待确认/);
  let maximumItems = 0;
  for (const region of [featureRegion]) {
    for (const fraction of [0, 0.5, 1, 1]) {
      await region.evaluate((element, fraction) => { element.scrollTop = (element.scrollHeight - element.clientHeight) * fraction; }, fraction);
      await page.waitForTimeout(60);
      const count = await region.getByRole('listitem').count();
      assert.ok(count > 0 && count < 40, String(count));
      maximumItems = Math.max(maximumItems, count);
    }
  }
  await page.getByText('合成功能 A 319', { exact: true }).waitFor();
  evidence.featuresPopulatedRows = 320;
  evidence.featuresMaxMountedItemsPerList = maximumItems;
  evidence.featuresHumanLabelsAndVirtualEnd = true;
  await capture('features-lists');
  for (const completion of ['resolve', 'reject']) {
    await open('features');
    await page.getByText('合成功能 A 0', { exact: true }).waitFor();
    await page.locator('#runtime-fixture-hold-read').click();
    await page.getByRole('button', { name: '重新读取', exact: true }).click();
    await pending(1);
    await page.locator('#runtime-fixture-disconnect').click();
    await page.locator('#runtime-fixture-source-b').click();
    await page.locator('#runtime-fixture-hold-read').click();
    await page.locator('#runtime-fixture-connect').click();
    await showFeatureSettings();
    await pending(2);
    await page.locator(`#runtime-fixture-${completion}`).click();
    await pending(1);
    assert.equal(await page.getByRole('button', { name: '重新读取', exact: true }).isDisabled(), true);
    assert.equal(await page.getByText('合成功能 A 0', { exact: true }).count(), 0);
    await page.locator('#runtime-fixture-resolve').click();
    await pending(0);
    await page.getByText('合成功能 B 0', { exact: true }).waitFor();
    await noWrites();
  }
  evidence.featuresApiSwapOldSuccessFailureFinallyCannotReplaceNewRead = true;
  for (const completion of ['resolve', 'reject']) {
    await open('features');
    await page.getByText('合成功能 A 0', { exact: true }).waitFor();
    await page.locator('#runtime-fixture-hold-read').click();
    await page.getByRole('button', { name: '重新读取', exact: true }).click();
    await pending(1);
    await page.locator('#runtime-fixture-disconnect').click();
    await page.locator('#runtime-fixture-source-b').click();
    await page.locator('#runtime-fixture-connect').click();
    await showFeatureSettings();
    await page.getByText('合成功能 B 0', { exact: true }).waitFor();
    await page.locator(`#runtime-fixture-${completion}`).click();
    await pending(0);
    await page.waitForTimeout(40);
    assert.equal(await page.getByText('合成功能 B 0', { exact: true }).count(), 1);
    assert.equal(await page.getByText('合成功能 A 0', { exact: true }).count(), 0);
    await noWrites();
  }
  evidence.featuresLateOldSuccessAndFailureAfterNewSuccessIgnored = true;
  for (const completion of ['resolve', 'reject']) {
    await open('features-draft');
    const draft = page.getByRole('textbox', { name: /合成功能草稿/ });
    await draft.waitFor();
    await draft.fill('仍未保存的功能配置草稿');
    await draft.evaluate(element => element.setAttribute('data-retained-draft', 'yes'));
    await page.locator('#runtime-fixture-hold-read').click();
    await page.locator('[data-page="features"] > div').first().getByRole('button', { name: '重新读取', exact: true }).click();
    await pending(1);
    assert.equal(await draft.inputValue(), '仍未保存的功能配置草稿');
    await page.locator(`#runtime-fixture-${completion === 'reject' ? 'reject503' : 'resolve'}`).click();
    await pending(0);
    await page.waitForTimeout(50);
    assert.equal(await draft.inputValue(), '仍未保存的功能配置草稿');
    assert.equal(await draft.getAttribute('data-retained-draft'), 'yes');
    const scopes = asRecord(JSON.parse(await page.locator('#runtime-fixture-state').getAttribute('data-dirty') ?? '{}') as unknown);
    assert.equal(scopes['configuration:features'], true);
    if (completion === 'reject') assert.match(await page.locator('[data-page="features"]').innerText(), /上次|保留的/);
    await noWrites();
  }
  evidence.featuresSameApiReloadSuccessFailureRetainsActualConfigurationDraft = true;
  await capture('features-draft');
  await open('features-draft');
  const isolatedDraft = page.getByRole('textbox', { name: /合成功能草稿/ });
  await isolatedDraft.fill('仅属于 API A 的草稿');
  await isolatedDraft.evaluate(element => element.setAttribute('data-old-api-draft', 'yes'));
  await page.locator('#runtime-fixture-source-b').click();
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLInputElement>('input')].some(input => input.value === 'saved-B'));
  assert.equal(await isolatedDraft.getAttribute('data-old-api-draft'), null);
  assert.equal(await isolatedDraft.inputValue(), 'saved-B');
  await noWrites();
  for (const completion of ['resolve', 'reject']) {
    await page.goto(`${origin}/test/fixtures/execution-runtime.html?view=features-draft&holdConfig=1`);
    await showFeatureSettings();
    await pending(1);
    await page.locator('#runtime-fixture-source-b').click();
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLInputElement>('input')].some(input => input.value === 'saved-B'));
    await page.locator(`#runtime-fixture-${completion}`).click();
    await pending(0);
    await page.waitForTimeout(40);
    assert.equal(await page.getByRole('textbox', { name: /合成功能草稿/ }).inputValue(), 'saved-B');
    await noWrites();
  }
  evidence.featuresApiSwapUnmountsOldEditorAndLateConfigurationResponses = true;
  for (const phase of ['post', 'readback']) {
    for (const completion of ['resolve', 'reject']) {
      for (const order of ['old-first', 'new-first']) {
        await open('features-draft');
        const draft = page.getByRole('textbox', { name: /合成功能草稿/ });
        const save = page.getByRole('button', { name: /^(保存本组|正在保存)$/ });
        await draft.fill('仅属于旧连接 A 的保存内容');
        await page.locator(`#runtime-fixture-hold-${phase === 'post' ? 'write' : 'read'}`).click();
        await save.click();
        await pending(1);
        await page.locator('#runtime-fixture-source-b').click();
        await page.waitForFunction(() => [...document.querySelectorAll<HTMLInputElement>('input')].some(input => input.value === 'saved-B'));
        await draft.fill('仅属于新连接 B 的保存内容');
        if (order === 'old-first') await page.locator('#runtime-fixture-hold-write').click();
        await save.click();
        if (order === 'old-first') {
          await pending(2);
          await page.locator(`#runtime-fixture-${completion}`).click();
          await pending(1);
          await page.waitForTimeout(40);
          assert.equal(await draft.inputValue(), '仅属于新连接 B 的保存内容');
          assert.equal(await save.isDisabled(), true);
          await save.evaluate(element => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
          assert.equal(await writeCount(), 2);
          await page.locator('#runtime-fixture-resolve').click();
          await pending(0);
        } else {
          await page.waitForFunction(() => document.body.innerText.includes('设置已保存'));
          await page.locator(`#runtime-fixture-${completion}`).click();
          await pending(0);
        }
        await page.waitForFunction(() => document.body.innerText.includes('设置已保存'));
        await page.waitForTimeout(40);
        assert.equal(await draft.inputValue(), '仅属于新连接 B 的保存内容');
        assert.equal(await writeCount(), 2);
        const write = await lastWrite();
        assert.equal(write.source, 'B');
        assert.equal(write.path, '/api/configuration');
        assert.equal(asRecord(asRecord(write.body).changes)['fixture.draft'], '仅属于新连接 B 的保存内容');
        const dirty = asRecord(JSON.parse(await page.locator('#runtime-fixture-state').getAttribute('data-dirty') ?? '{}') as unknown);
        assert.equal(dirty['configuration:features'], false);
        assert.equal(await page.getByText('正在保存更改', { exact: true }).count(), 0);
      }
    }
  }
  evidence.configurationOldPostAndReadbackSuccessFailureCannotReplaceOrUnlockNewSave = true;
  for (const completion of ['resolve', 'reject']) {
    for (const order of ['old-first', 'new-first']) {
      await page.goto(`${origin}/test/fixtures/execution-runtime.html?view=features-draft&applyConfig=1`);
      await showFeatureSettings();
      const draft = page.getByRole('textbox', { name: /合成功能草稿/ });
      const apply = page.getByRole('button', { name: /^(应用合成配置|正在应用)$/ });
      await draft.fill('旧连接 A 合成待应用配置');
      await page.getByRole('button', { name: '保存本组', exact: true }).click();
      await page.waitForFunction(() => document.body.innerText.includes('已保存，等待应用'));
      await page.locator('#runtime-fixture-hold-write').click();
      await apply.click();
      await pending(1);
      await page.locator('#runtime-fixture-source-b').click();
      await page.waitForFunction(() => [...document.querySelectorAll<HTMLInputElement>('input')].some(input => input.value === 'saved-B'));
      await draft.fill('新连接 B 合成待应用配置');
      await page.getByRole('button', { name: '保存本组', exact: true }).click();
      await page.waitForFunction(() => document.body.innerText.includes('已保存，等待应用'));
      if (order === 'old-first') await page.locator('#runtime-fixture-hold-write').click();
      await apply.click();
      if (order === 'old-first') {
        await pending(2);
        await page.locator(`#runtime-fixture-${completion}`).click();
        await pending(1);
        await page.waitForTimeout(40);
        assert.equal(await apply.isDisabled(), true);
        await apply.evaluate(element => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
        assert.equal(await writeCount(), 4);
        assert.equal(await page.getByText('配置应用流程已完成', { exact: true }).count(), 0);
        await page.locator('#runtime-fixture-resolve').click();
        await pending(0);
      } else {
        await page.waitForFunction(() => document.body.innerText.includes('配置应用流程已完成'));
        await page.locator(`#runtime-fixture-${completion}`).click();
        await pending(0);
      }
      await page.waitForFunction(() => document.body.innerText.includes('配置应用流程已完成'));
      await page.waitForTimeout(40);
      assert.equal(await draft.inputValue(), '新连接 B 合成待应用配置');
      assert.equal(await writeCount(), 4);
      const write = await lastWrite();
      assert.equal(write.source, 'B');
      assert.equal(write.path, '/api/configuration/apply');
    }
  }
  evidence.configurationOldApplySuccessFailureCannotReplaceOrUnlockNewApply = true;
  await capture('configuration-lifecycle');
  for (const state of ['stopped', 'error']) {
    await page.goto(`${origin}/test/fixtures/execution-runtime.html?view=features&catalogState=${state}`);
    await showFeatureSettings();
    await page.getByText('聊天暂未就绪。', { exact: true }).waitFor();
    const visible = await page.locator('[data-page="features"]').innerText();
    assert.equal(visible.includes('原生聊天宿主未接入'), false);
    assert.equal(visible.includes('agent-relay'), false);
    assert.match(visible, /请到连接页查看连接和启动状态/);
    if (state === 'error') await page.getByText('聊天消息转接', { exact: true }).waitFor();
    else assert.equal(await page.getByRole('region', { name: '功能清单', exact: true }).count(), 0);
    await page.getByRole('button', { name: '查看聊天连接', exact: true }).click();
    assert.equal(await page.locator('#runtime-fixture-state').getAttribute('data-navigation'), 'adapters');
    await noWrites();
  }
  evidence.featuresUnreadyIsNotMissingModuleOrPermissionAndLinksToStartupChecks = true;
  for (const state of ['stopped', 'error']) {
    await page.goto(`${origin}/test/fixtures/execution-runtime.html?view=plans&catalogState=${state}`);
    await page.getByText('更新聊天会保存当前方案、选择启用并应用，保留已有上下文。', { exact: true }).waitFor();
    assert.equal((await page.locator('main').innerText()).includes('原生宿主未接入'), false);
    const name = page.getByRole('textbox', { name: '方案名称', exact: true });
    await name.fill('尚未运行也可编辑的方案草稿');
    await page.getByRole('button', { name: '查看 DSH 应用', exact: true }).click();
    await page.waitForFunction(() => {
      const target = document.getElementById('dsh-deployment')?.getBoundingClientRect();
      return target !== undefined && target.top < innerHeight && target.bottom > 0;
    });
    assert.equal(await page.locator('#runtime-fixture-state').getAttribute('data-navigation'), '');
    assert.equal(await name.inputValue(), '尚未运行也可编辑的方案草稿');
    await noWrites();
  }
  evidence.planUnreadyKeepsCatalogEditableWithoutDiagnosingMissingModules = true;
  return evidence;
}
