import postgres from "postgres";

let _sql: ReturnType<typeof postgres> | null = null;

export function getLcmConnection(databaseUrl: string): ReturnType<typeof postgres> {
  if (!_sql) {
    _sql = postgres(databaseUrl, {
      max: 10,
      idle_timeout: 20,
      max_lifetime: 30 * 60,
      prepare: false, // RDS Proxy compatibility
    });
  }
  return _sql;
}

export async function closeLcmConnection(): Promise<void> {
  if (_sql) {
    await _sql.end();
    _sql = null;
  }
}
