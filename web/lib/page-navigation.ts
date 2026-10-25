import { pageDefinition, registeredPageAlias, type CanonicalPageId } from './page-registry.ts';
import type { PageDestination, PageId } from './types.ts';

export function canonicalPageId(page: PageId): CanonicalPageId {
  return pageDefinition(page).id;
}

export function resolvePageNavigation(page: PageId, target?: PageDestination): { readonly page: PageId; readonly target?: PageDestination } {
  const canonical = canonicalPageId(page);
  if (canonical === page || target && target.kind !== 'page') return { page: canonical, ...(target ? { target } : {}) };
  return { page: canonical, target: registeredPageAlias(page)?.target };
}
