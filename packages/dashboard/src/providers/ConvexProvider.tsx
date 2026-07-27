// ConvexProvider — wraps the React app in a Convex realtime context.
//
// This replaces the need for a raw WebSocket connection to the Express API
// server for live data. Components under this provider can call
// `useQuery` / `useMutation` from 'convex/react' and get automatic
// subscriptions to the Convex deployment.
//
// The TanStack QueryClientProvider is kept alongside this (see main.tsx)
// because some components still fetch non-Convex data (e.g. legacy REST
// routes) via TanStack Query during the migration period.

import { ConvexProvider as ConvexReactProvider, ConvexReactClient } from 'convex/react';
import type { ReactNode } from 'react';

const CONVEX_URL = 'https://agile-tern-916.convex.cloud';

const convex = new ConvexReactClient(CONVEX_URL);

export function ConvexProvider({ children }: { children: ReactNode }) {
  return <ConvexReactProvider client={convex}>{children}</ConvexReactProvider>;
}
