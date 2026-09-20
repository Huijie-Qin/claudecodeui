// Minimal better-sqlite3-compatible, synchronous query facade over browser SQLite.
export function createOfflineDatabase(SQL, snapshot) {
  if (snapshot.kind !== 'ai-usage-synthetic-only' || snapshot.version !== 1) throw new Error('Invalid simulation snapshot');
  const sqlite = new SQL.Database();
  sqlite.run('BEGIN');
  try {
    for (const table of snapshot.tables) {
      sqlite.run(table.schema);
      const insert = sqlite.prepare(`INSERT INTO "${table.name}" VALUES (${table.columns.map(() => '?').join(',')})`);
      try { for (const row of table.rows) insert.run(row); } finally { insert.free(); }
      for (const index of table.indexes) sqlite.run(index);
    }
    sqlite.run('COMMIT');
  } catch (error) { sqlite.close(); throw error; }
  const bind = (args) => args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])
    ? Object.fromEntries(Object.entries(args[0]).map(([key, value]) => [`@${key}`, value ?? null]))
    : args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
  const query = (sql, args, single) => {
    const statement = sqlite.prepare(sql);
    try {
      statement.bind(bind(args));
      if (single) return statement.step() ? statement.getAsObject() : undefined;
      const rows = [];
      while (statement.step()) rows.push(statement.getAsObject());
      return rows;
    } finally { statement.free(); }
  };
  let transactionDepth = 0;
  const db = {
    prepare: (sql) => ({ get: (...args) => query(sql, args, true), all: (...args) => query(sql, args, false) }),
    transaction: (callback) => {
      const run = (...args) => {
        const nested = transactionDepth > 0;
        const savepoint = `report_read_${transactionDepth}`;
        sqlite.run(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN');
        transactionDepth++;
        try { const result = callback(...args); sqlite.run(nested ? `RELEASE ${savepoint}` : 'COMMIT'); return result; }
        catch (error) { sqlite.run(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK'); throw error; }
        finally { transactionDepth--; }
      };
      run.deferred = run;
      return run;
    },
    close: () => sqlite.close(),
  };
  return db;
}
