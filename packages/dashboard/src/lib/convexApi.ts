// ─── Convex function references, without the codegen dependency ──────────────
//
// The dashboard components used to import `api` from
// `@workspace/convex-backend/api`, which that package's `exports` map resolves
// to `./convex/_generated/api.js` — a file produced by `convex codegen` and
// covered by the repo's `**/convex/_generated` gitignore rule.
//
// So it does not exist in a fresh clone. Every Docker/Railway build ran
// `pnpm install` on a clean checkout and then died at:
//
//   [vite]: Rollup failed to resolve import "@workspace/convex-backend/api"
//           from "packages/dashboard/src/components/TaskBoard.tsx"
//
// which failed the image build, which is why nothing merged to main was
// reaching production. Reproduced locally 2026-07-29 before changing anything.
//
// The alternative fix — running `convex codegen` during the build — needs a
// CONVEX_DEPLOYMENT/deploy key present at image-build time and network access
// to Convex from the builder. That puts a deployment credential into the build
// and makes a hermetic build depend on a third-party service being reachable.
// Committing the generated output instead would work, but re-introduces the
// "regenerate or it silently drifts from schema.ts" failure mode.
//
// `anyApi` is Convex's supported way to reference functions by path without
// codegen. At runtime the generated `api` object is itself just a proxy that
// turns property access into a function path string — `anyApi` is that same
// proxy, minus the generated types. Identical wire behavior; the only loss is
// compile-time checking of function names and argument shapes.
//
// Worth knowing: `packages/convex-backend` does not currently typecheck (its
// `convex/toolRegistry.ts` was never codegen'd or verified — see apexplan.md),
// so those generated types were not actually protecting anything today.
//
// If/when the Convex migration is finished, swap this back to the generated
// api and delete this file — the import site is the only thing that changes.

import { anyApi } from 'convex/server';

/** Path-based Convex function references. Usage is unchanged from the
 *  generated client: `api.tasks.list`, `api.agents.list`, etc. */
export const api = anyApi;
