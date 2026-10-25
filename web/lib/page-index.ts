export interface PageIndexEntry {
  readonly id: string;
  readonly title: string;
  readonly sectionTitle: string;
  readonly sectionId?: string;
  readonly kind: 'section' | 'field';
  readonly element: HTMLElement;
}

export function resolvePageFocusTarget(entry: PageIndexEntry): HTMLElement {
  if (entry.kind !== 'field') return entry.element;
  const label = entry.element.closest<HTMLLabelElement>('label');
  const group = entry.element.closest<HTMLElement>('[data-page-field], [role="group"]');
  const selector = 'input:not([type="hidden"]), textarea, select, button, [role="combobox"], [role="switch"], [role="checkbox"], [role="textbox"], [contenteditable="true"]';
  const candidates = new Set<HTMLElement>();
  if (label?.control) candidates.add(label.control);
  for (const container of [label, group]) {
    if (container) for (const control of container.querySelectorAll<HTMLElement>(selector)) candidates.add(control);
  }
  for (const control of candidates) {
    if (!control.isConnected || !control.matches(selector) || control.matches(':disabled')
      || control.closest('[hidden], [inert], [aria-hidden="true"], [aria-disabled="true"], fieldset:disabled')
      || control.getClientRects().length === 0) continue;
    const visibility = control.ownerDocument.defaultView?.getComputedStyle(control).visibility;
    if (visibility !== 'hidden' && visibility !== 'collapse') return control;
  }
  return entry.element;
}

export function matchesPageSearch(query: string, ...labels: string[]): boolean {
  const words = query.normalize('NFKC').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const text = labels.join(' ').normalize('NFKC').toLocaleLowerCase();
  return words.every(word => text.includes(word));
}

function explicitlyHidden(element: HTMLElement, root: HTMLElement): boolean {
  let current: HTMLElement | null = element;
  while (current && current !== root) {
    if (current.hidden || current.classList.contains('hidden') || current.getAttribute('aria-hidden') === 'true') return true;
    current = current.parentElement;
  }
  return false;
}

export function indexPage(root: HTMLElement): PageIndexEntry[] {
  const entries: PageIndexEntry[] = [];
  for (const [sectionIndex, section] of Array.from(root.querySelectorAll('section')).entries()) {
    if (explicitlyHidden(section, root)) continue;
    const heading = Array.from(section.querySelectorAll('h2')).find(element => element.closest('section') === section);
    const title = heading?.textContent?.trim();
    if (!heading || !title) continue;
    const sectionId = `section-${sectionIndex}`;
    entries.push({ id: sectionId, title, sectionTitle: title, sectionId: section.id || undefined, kind: 'section', element: heading });
    const seen = new Set<string>();
    const labels = section.querySelectorAll<HTMLElement>('.field-label, label > span:first-child, [role="group"][aria-label]');
    for (const label of labels) {
      if (label.closest('section') !== section || explicitlyHidden(label, root) || label.classList.contains('sr-only')) continue;
      const text = (label.getAttribute('role') === 'group' ? label.getAttribute('aria-label') : label.textContent)?.trim();
      if (!text || text.length > 160 || seen.has(text)) continue;
      seen.add(text);
      entries.push({ id: `${sectionId}-field-${seen.size}`, title: text, sectionTitle: title, sectionId: section.id || undefined, kind: 'field', element: label });
    }
  }
  return entries;
}

export interface PageSearchLocator {
  readonly title: string;
  readonly sectionTitle?: string;
  readonly sectionId?: string;
  readonly fallbackSectionId?: string;
  readonly kind: 'page' | 'section' | 'field';
}

export function resolvePageSearchTarget(entries: readonly PageIndexEntry[], target: PageSearchLocator) {
  const inSection = (entry: PageIndexEntry) => target.sectionId
    ? entry.sectionId === target.sectionId
    : !target.sectionTitle || entry.sectionTitle === target.sectionTitle;
  const match = entries.find(entry => entry.kind === target.kind && inSection(entry)
    && (target.kind === 'section' && target.sectionId !== undefined || entry.title === target.title));
  const section = entries.find(entry => entry.kind === 'section' && inSection(entry))
    ?? entries.find(entry => entry.kind === 'section' && target.fallbackSectionId && entry.sectionId === target.fallbackSectionId);
  return { match, section };
}
