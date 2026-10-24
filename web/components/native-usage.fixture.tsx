import { useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { UsagePage } from '../pages/usage.tsx';
import { ApiError, asRecord, type ApiClient } from '../lib/api.ts';
import type { PageProps } from '../lib/types.ts';
import '../console.css';

const api: ApiClient = {
  async get(path, signal) {
    const response = await fetch(`/isolated-native-api${path}`, { signal });
    const value: unknown = await response.json();
    if (!response.ok) throw new ApiError(String(asRecord(value).error), response.status);
    return value;
  },
  async post(path, body, signal) {
    const response = await fetch(`/isolated-native-api${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' }, signal });
    const value: unknown = await response.json();
    if (!response.ok) throw new ApiError(String(asRecord(value).error), response.status);
    return value;
  },
};

function Fixture() {
  const [version, setVersion] = useState(0);
  const [dirty, setDirty] = useState(false);
  const reportDirty = useCallback((value: boolean) => setDirty(value), []);
  const props: PageProps = { api, connected: true, snapshot: {}, connect() {}, async refresh() {}, navigate() {}, setDirty: reportDirty };
  async function seed(kind: string) {
    await fetch('/isolated-native-control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'seed', kind }) });
    setVersion(value => value + 1);
  }
  return <main className="mx-auto grid max-w-[90rem] gap-5 p-5"><nav className="flex gap-3">{['empty', 'complete', 'partial', 'mixed'].map(kind => <button key={kind} data-native-seed={kind} onClick={() => void seed(kind)}>{kind}</button>)}<output data-native-pricing-dirty={dirty} data-native-fixture-version={version}>{dirty ? '单价未保存' : '单价已载入'}</output></nav><UsagePage key={version} {...props} /></main>;
}
const root = document.getElementById('root');
if (!root) throw new Error('fixture_root_missing');
createRoot(root).render(<Fixture />);
