export interface PageIndexEntry {
  readonly id: string;
  readonly title: string;
  readonly sectionTitle: string;
  readonly kind: 'section' | 'field';
  readonly element: HTMLElement;
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
    entries.push({ id: sectionId, title, sectionTitle: title, kind: 'section', element: heading });
    const seen = new Set<string>();
    const labels = section.querySelectorAll<HTMLElement>('.field-label, label > span:first-child, [role="group"][aria-label]');
    for (const label of labels) {
      if (label.closest('section') !== section || explicitlyHidden(label, root) || label.classList.contains('sr-only')) continue;
      const text = (label.getAttribute('role') === 'group' ? label.getAttribute('aria-label') : label.textContent)?.trim();
      if (!text || text.length > 160 || seen.has(text)) continue;
      seen.add(text);
      entries.push({ id: `${sectionId}-field-${seen.size}`, title: text, sectionTitle: title, kind: 'field', element: label });
    }
  }
  return entries;
}
