import type { ApiClient } from './api.ts';
import type { PageSearchLocator } from './page-index.ts';

import type { PageId } from './page-registry.ts';
export type { PageId } from './page-registry.ts';

export interface PageDestination extends PageSearchLocator {
  readonly unavailableMessage?: string;
}

export interface PageProps {
  readonly connected: boolean;
  readonly snapshot: Readonly<Record<string, unknown>>;
  readonly api: ApiClient;
  refresh(): Promise<void>;
  navigate(page: PageId, target?: PageDestination): void;
  connect(): void;
  setDirty(value: boolean, scope?: string): void;
}
