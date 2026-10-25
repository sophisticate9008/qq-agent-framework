import assert from 'node:assert/strict';
import test from 'node:test';
import { resolvePageFocusTarget, type PageIndexEntry } from '../web/lib/page-index.ts';

interface ControlOptions {
  readonly disabled?: boolean;
  readonly disconnected?: boolean;
  readonly hidden?: boolean;
  readonly hiddenAncestor?: boolean;
  readonly visibility?: string;
}

function control(options: ControlOptions = {}): HTMLElement {
  return {
    isConnected: !options.disconnected,
    matches: (selector: string) => selector === ':disabled' ? options.disabled === true : true,
    closest: () => options.hiddenAncestor ? {} : null,
    getClientRects: () => ({ length: options.hidden ? 0 : 1 }),
    ownerDocument: { defaultView: { getComputedStyle: () => ({ visibility: options.visibility ?? 'visible' }) } },
  } as unknown as HTMLElement;
}

function field(candidates: readonly HTMLElement[], associated?: HTMLElement, grouped = false): PageIndexEntry {
  const container = { control: associated ?? null, querySelectorAll: () => candidates };
  return { id: 'field-1', title: '公开字段', sectionTitle: '设置', kind: 'field', element: {
    closest: (selector: string) => grouped ? selector === 'label' ? null : container : selector === 'label' ? container : null,
  } as unknown as HTMLElement };
}

test('field focus resolves the actual associated control before other local actions', () => {
  const input = control();
  const unrelatedButton = control();
  const entry = field([unrelatedButton], input);
  assert.equal(resolvePageFocusTarget(entry), input);
});

test('field focus skips hidden, disabled, detached and nonvisible controls', () => {
  const input = control();
  const hidden = control({ hidden: true });
  const entry = field([hidden, control({ disabled: true }), control({ disconnected: true }),
    control({ hiddenAncestor: true }), control({ visibility: 'hidden' }), control({ visibility: 'collapse' }), input], hidden);
  assert.equal(resolvePageFocusTarget(entry), input);
});

test('field focus uses only a declared field group when there is no native label', () => {
  const toggle = control();
  assert.equal(resolvePageFocusTarget(field([toggle], undefined, true)), toggle);
});

test('unavailable fields and section headings retain their label navigation fallback', () => {
  const entry = field([control({ disabled: true })]);
  assert.equal(resolvePageFocusTarget(entry), entry.element);
  const section: PageIndexEntry = { ...entry, kind: 'section' };
  assert.equal(resolvePageFocusTarget(section), section.element);
});

test('focus resolution is read-only and never executes field controls', () => {
  const input = Object.freeze(control());
  const entry = field([input]);
  const before = Object.getOwnPropertyDescriptors(input);
  assert.equal(resolvePageFocusTarget(entry), input);
  assert.deepEqual(Object.getOwnPropertyDescriptors(input), before);
});
