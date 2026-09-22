// tests/fakeSupabase.js
// A small, honest fake of the Supabase JS client's query builder — only the
// operations this codebase actually uses (from/select/insert/update/upsert/
// eq/gte/maybeSingle/single/limit/order), backed by an in-memory Map. This
// is what makes real endpoint tests possible without a live database: every
// lib/*.js file gets its `admin()` call redirected to one of these per test.

class QueryBuilder {
  constructor(store, table) {
    this.store = store;
    this.table = table;
    this.filters = [];
    this._insertRows = null;
    this._updatePatch = null;
    this._upsertRow = null;
    this._limit = null;
    this._single = false;
    this._maybeSingle = false;
  }
  select() { return this; }
  eq(col, val) { this.filters.push(row => row[col] === val); return this; }
  // Real supabase-js requires .is(col, null) rather than .eq(col, null) for
  // null checks (PostgREST's eq operator doesn't do IS NULL). This fake
  // mirrors that: treat a missing key the same as an explicit null.
  is(col, val) { this.filters.push(row => (row[col] === undefined ? null : row[col]) === val); return this; }
  gte(col, val) { this.filters.push(row => row[col] >= val); return this; }
  order() { return this; }
  limit(n) { this._limit = n; return this; }
  insert(rows) { this._insertRows = Array.isArray(rows) ? rows : [rows]; return this; }
  update(patch) { this._updatePatch = patch; return this; }
  upsert(row) { this._upsertRow = row; return this; }
  maybeSingle() { this._maybeSingle = true; return this; }
  single() { this._single = true; return this; }

  _rows() {
    const all = this.store.get(this.table) || [];
    return all.filter(row => this.filters.every(f => f(row)));
  }

  async _execute() {
    const table = this.store.get(this.table) || [];

    if (this._insertRows) {
      const withIds = this._insertRows.map(r => ({ id: r.id || 'id_' + Math.random().toString(36).slice(2), ...r }));
      this.store.set(this.table, [...table, ...withIds]);
      if (this._single) return { data: withIds[0], error: null };
      return { data: withIds, error: null };
    }

    if (this._upsertRow) {
      const keyCol = Object.keys(this._upsertRow)[0]; // good enough for our single-PK tables in tests
      const idx = table.findIndex(r => r[keyCol] === this._upsertRow[keyCol]);
      if (idx >= 0) table[idx] = { ...table[idx], ...this._upsertRow };
      else table.push({ ...this._upsertRow });
      this.store.set(this.table, table);
      return { data: this._upsertRow, error: null };
    }

    if (this._updatePatch) {
      const matched = this._rows();
      matched.forEach(row => Object.assign(row, this._updatePatch));
      return { data: matched, error: null };
    }

    // plain select
    let rows = this._rows();
    if (this._limit) rows = rows.slice(0, this._limit);
    if (this._maybeSingle) return { data: rows[0] || null, error: null };
    if (this._single) return rows[0] ? { data: rows[0], error: null } : { data: null, error: { message: 'not found' } };
    return { data: rows, error: null };
  }

  then(resolve, reject) { return this._execute().then(resolve, reject); }
}

function createFakeSupabase({ validToken = 'valid-test-token', userId = 'test-user-id' } = {}) {
  const store = new Map();
  return {
    _store: store, // exposed so tests can seed data directly
    from(table) { return new QueryBuilder(store, table); },
    async rpc(name, args) {
      if (name !== 'consume_rate_limit') return { data: null, error: { message: 'unknown rpc' } };
      const now = Date.now();
      const rows = store.get('rate_limits') || [];
      let row = rows.find(r => r.key === args.p_key);
      if (!row) {
        row = { key: args.p_key, window_start: new Date(now).toISOString(), count: 1 };
        rows.push(row); store.set('rate_limits', rows);
        return { data: [{ allowed: true, retry_after_seconds: 0 }], error: null };
      }
      const elapsed = (now - new Date(row.window_start).getTime()) / 1000;
      if (elapsed >= args.p_window_seconds) {
        row.window_start = new Date(now).toISOString(); row.count = 1;
        return { data: [{ allowed: true, retry_after_seconds: 0 }], error: null };
      }
      if (row.count >= args.p_limit) {
        return { data: [{ allowed: false, retry_after_seconds: Math.max(1, Math.ceil(args.p_window_seconds - elapsed)) }], error: null };
      }
      row.count += 1;
      return { data: [{ allowed: true, retry_after_seconds: 0 }], error: null };
    },
    auth: {
      async getUser(token) {
        if (token === validToken) return { data: { user: { id: userId } }, error: null };
        return { data: null, error: { message: 'invalid token' } };
      }
    }
  };
}

module.exports = { createFakeSupabase };
