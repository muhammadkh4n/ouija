/**
 * App — top-level shell.
 *
 * Gatekeeps on the presence of an API token. If missing, shows the token
 * entry screen. Once present, renders the router with all the pages.
 *
 * The router is intentionally tiny for v1 — just the pipeline list and a
 * placeholder detail route. Follow-on sessions layer in SSE/log streaming
 * and richer views.
 */

import { useState, useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
} from 'react-router-dom';
import { PipelineList } from './pages/PipelineList.js';
import { PipelineDetail } from './pages/PipelineDetail.js';
import { TokenEntry } from './pages/TokenEntry.js';
import { ToastProvider } from './components/Toast.js';
import { ApiError, getApiKey } from './lib/api-client.js';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        // Don't retry on auth errors — surface them immediately.
        if (error instanceof ApiError && error.status === 401) return false;
        return failureCount < 2;
      },
      refetchOnWindowFocus: true,
    },
  },
});

export function App() {
  const [hasToken, setHasToken] = useState<boolean>(() => getApiKey() !== null);
  const [authError, setAuthError] = useState<string | undefined>(undefined);

  // Listen for 401s from any query and bounce back to the token screen.
  useEffect(() => {
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated') return;
      const err = event.query.state.error;
      if (err instanceof ApiError && err.status === 401) {
        setAuthError('Token rejected by the server. Try a fresh one.');
        setHasToken(false);
      }
    });
    return unsubscribe;
  }, []);

  if (!hasToken) {
    return <TokenEntry errorHint={authError} />;
  }

  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BrowserRouter basename="/dashboard">
          <Routes>
            <Route path="/" element={<PipelineList />} />
            <Route path="/pipelines/:id" element={<PipelineDetail />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}
