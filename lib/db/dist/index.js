export { db, schema } from './migrate.js';
export * from './schema.js';
export * from './schema-revenue-ops.js';
// Phase 1.2 (compliance + capture + mission lifecycle) tables are re-exported
// from schema-revenue-ops.js above. Keep the migrate barrel separate so the
// migration runtime can evolve independently of the static schema definitions.
export { migrate } from './migrate.js';
