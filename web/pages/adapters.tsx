import { AdapterManager } from '../components/adapter-manager.tsx';
import type { PageProps } from '../lib/types.ts';

export function AdaptersPage(props: PageProps) {
  return <div className="page-stack" data-page="adapters"><AdapterManager {...props} /></div>;
}
