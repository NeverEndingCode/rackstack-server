// pg returns int8/BIGINT as a STRING by default, to avoid precision loss
// above 2^53. Every BIGINT in this schema is an epoch-millisecond timestamp
// (created_at, last_save, starts_at, ends_at, ...) - all far below 2^53, and
// every consumer does arithmetic or comparison on them. Left as strings,
// `now > state.server.anomalyExpiresAt` and every offline-gap calculation
// silently misbehave. Parse them back to numbers.
//
// Imported purely for this module-scope side effect by every module that
// opens a `pg` connection (driver.pg.js, migrate.js) so the registration
// happens exactly once per process, regardless of which one runs first, and
// the two can't drift on how BIGINT gets parsed.
import pg from 'pg';

pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : Number(v)));
