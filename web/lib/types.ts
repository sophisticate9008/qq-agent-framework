import type { ApiClient } from './api.ts';

export type PageId = 'overview' | 'persona' | 'features' | 'access' | 'model' | 'settings' | 'sessions' | 'usage';

export interface PageProps {
  readonly connected: boolean;
  readonly snapshot: Readonly<Record<string, unknown>>;
  readonly api: ApiClient;
  refresh(): Promise<void>;
  navigate(page: PageId): void;
  connect(): void;
  setDirty(value: boolean, scope?: string): void;
}
