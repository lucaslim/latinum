import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

/** Any Drizzle Postgres database: the Neon pool in production, PGlite locally and in tests. */
export type Database = PgDatabase<PgQueryResultHKT>;

/** Scopes a database handle to one unit of work, so the driver decides its own connection lifetime. */
export type WithDb = <T>(use: (db: Database) => Promise<T>) => Promise<T>;
