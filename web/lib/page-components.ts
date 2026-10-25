import { lazy, type ComponentType } from 'react';
import { pageRegistry } from './page-registry.ts';
import type { PageProps } from './types.ts';

const modules = import.meta.glob<Readonly<Record<string, ComponentType<PageProps>>>>('../pages/*.tsx');

/** A registered id resolves to pages/<id>.tsx and its <Id>Page named export. */
export const pageComponents = new Map(pageRegistry.map(page => [page.id, lazy(async () => {
  const load = modules[`../pages/${page.id}.tsx`];
  if (!load) throw new Error(`Page component module missing: ${page.id}`);
  const module = await load();
  const component = module[`${page.id.charAt(0).toUpperCase()}${page.id.slice(1)}Page`];
  if (!component) throw new Error(`Page component export missing: ${page.id}`);
  return { default: component };
})]));
