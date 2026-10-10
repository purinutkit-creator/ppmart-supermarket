import pg from 'pg';
import { config } from './config';

// BIGINT (int8) -> number (satang amounts are far below 2^53), NUMERIC -> number
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));
// DATE -> plain 'YYYY-MM-DD' string (avoid timezone shifts)
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_OVERRIDE || config.databaseUrl, max: 20 });

export type Db = pg.Pool | pg.PoolClient;

export async function q<T = any>(sql: string, params: any[] = [], db: Db = pool): Promise<T[]> {
  const r = await db.query(sql, params);
  return r.rows as T[];
}

export async function one<T = any>(sql: string, params: any[] = [], db: Db = pool): Promise<T | undefined> {
  const r = await db.query(sql, params);
  return r.rows[0] as T | undefined;
}

/** Run fn inside a transaction. Retries on serialization failures / deadlocks. */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>, retries = 3): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const res = await fn(c);
      await c.query('COMMIT');
      return res;
    } catch (e: any) {
      await c.query('ROLLBACK').catch(() => {});
      if ((e.code === '40001' || e.code === '40P01') && attempt < retries) continue;
      throw e;
    } finally {
      c.release();
    }
  }
}
