import { Pool } from "pg"

// Reuse one pool across hot reloads in dev (Next.js re-evaluates modules).
const globalForDb = globalThis as unknown as { pgPool?: Pool }

export const pool =
  globalForDb.pgPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
  })

if (process.env.NODE_ENV !== "production") globalForDb.pgPool = pool

export async function query<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params: ReadonlyArray<unknown> = [],
): Promise<{ rows: T[] }> {
  return pool.query(text, params as unknown[])
}
