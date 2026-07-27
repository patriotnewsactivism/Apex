// Convex client setup for the APEX dashboard.
//
// `convexClient` (ConvexHttpClient) is used for one-off / non-react queries
// and server-side fetches. For live, reactive data the React components use
// the ConvexProvider (see ../providers/ConvexProvider) which wraps a
// ConvexReactClient and powers the `useQuery` hook from 'convex/react'.
//
// `anyApi` is re-exported for cases where a caller needs to reference a
// Convex function by string name without the generated typed `api` object.

import { ConvexHttpClient } from 'convex/browser';
import { anyApi } from 'convex/server';

const CONVEX_URL = 'https://agile-tern-916.convex.cloud';

export const convexClient = new ConvexHttpClient(CONVEX_URL);

export { anyApi };
