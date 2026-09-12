import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../api/client';
import type { AuthUser, Workspace } from '../api/types';

type AuthState = {
  user: AuthUser | null;
  workspaces: Workspace[];
  workspaceId: string | null;
  loading: boolean;
  setWorkspaceId: (id: string) => void;
  login: (email: string, password: string) => Promise<void>;
  register: (input: { email: string; password: string; displayName: string; timezone: string }) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [workspaceId, setWorkspaceIdState] = useState<string | null>(() => localStorage.getItem('balcony_workspace'));
  const query = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: async () => (await api.get<{ user: AuthUser; workspaces: Workspace[] }>('/auth/me')).data,
    retry: false,
  });

  const workspaces = query.data?.workspaces ?? [];
  useEffect(() => {
    if (workspaces.length === 0) return;
    if (!workspaceId || !workspaces.some((workspace) => workspace.id === workspaceId)) {
      setWorkspaceIdState(workspaces[0]!.id);
      localStorage.setItem('balcony_workspace', workspaces[0]!.id);
    }
  }, [workspaceId, workspaces]);

  const value = useMemo<AuthState>(
    () => ({
      user: query.data?.user ?? null,
      workspaces,
      workspaceId,
      loading: query.isLoading,
      setWorkspaceId: (id) => {
        setWorkspaceIdState(id);
        localStorage.setItem('balcony_workspace', id);
      },
      login: async (email, password) => {
        await api.post('/auth/login', { email, password });
        await query.refetch();
      },
      register: async (input) => {
        await api.post('/auth/register', input);
        await query.refetch();
      },
      logout: async () => {
        try {
          await api.post('/auth/logout');
        } finally {
          queryClient.clear();
          localStorage.removeItem('balcony_workspace');
          setWorkspaceIdState(null);
        }
      },
      refresh: async () => {
        await query.refetch();
      },
    }),
    [query, queryClient, workspaceId, workspaces],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}

export function authErrorMessage(error: unknown) {
  return errorMessage(error);
}
