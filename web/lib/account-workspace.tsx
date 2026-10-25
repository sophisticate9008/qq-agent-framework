import { createContext, useContext } from 'react';
import type { NativeAccountView } from '../../src/contracts/native-accounts.ts';
import type { ApiClient } from './api.ts';
export interface AccountWorkspace { readonly globalApi: ApiClient; readonly selected: NativeAccountView | null; select(account: NativeAccountView | null): void }
export const AccountWorkspaceContext = createContext<AccountWorkspace | null>(null);
export const useAccountWorkspace = () => useContext(AccountWorkspaceContext);
