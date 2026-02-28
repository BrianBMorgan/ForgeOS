import { useState, useEffect, useRef } from "react";

interface TableInfo {
  table_name: string;
  table_schema: string;
}

interface ColumnInfo {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
  character_maximum_length: number | null;
}

interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  duration: number;
}

const API_BASE = "/api";

export default function DbTab() {
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [rowCount, setRowCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [view, setView] = useState<"browse" | "query">("browse");
  const [sql, setSql] = useState("SELECT * FROM ");
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [queryLoading, setQueryLoading] = useState(false);
  const [dbAvailable, setDbAvailable] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const PAGE_SIZE = 50;

  useEffect(() => {
    loadTables();
  }, []);

  async function loadTables() {
    try {
      const res = await fetch(`${API_BASE}/db/tables`);
      if (res.status === 503) {
        setDbAvailable(false);
        return;
      }
      if (!res.ok) throw new Error("Failed to load tables");
      const data = await res.json();
      setTables(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load tables");
    }
  }

  async function selectTable(name: string) {
    setSelectedTable(name);
    setPage(0);
    setError(null);
    setLoading(true);
    try {
      const [metaRes, rowsRes] = await Promise.all([
        fetch(`${API_BASE}/db/tables/${name}`),
        fetch(`${API_BASE}/db/tables/${name}/rows?limit=${PAGE_SIZE}&offset=0`),
      ]);
      if (!metaRes.ok || !rowsRes.ok) throw new Error("Failed to load table data");
      const meta = await metaRes.json();
      const rowData = await rowsRes.json();
      setColumns(meta.columns);
      setRowCount(meta.rowCount);
      setRows(rowData);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load table");
    } finally {
      setLoading(false);
    }
  }

  async function loadPage(newPage: number) {
    if (!selectedTable) return;
    setPage(newPage);
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/db/tables/${selectedTable}/rows?limit=${PAGE_SIZE}&offset=${newPage * PAGE_SIZE}`);
      if (!res.ok) throw new Error("Failed to load rows");
      const data = await res.json();
      setRows(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load page");
    } finally {
      setLoading(false);
    }
  }

  async function runQuery() {
    if (!sql.trim()) return;
    setQueryLoading(true);
    setQueryError(null);
    setQueryResult(null);
    try {
      const res = await fetch(`${API_BASE}/db/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: sql.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setQueryError(data.error || "Query failed");
      } else {
        setQueryResult(data);
      }
    } catch (err: unknown) {
      setQueryError(err instanceof Error ? err.message : "Query failed");
    } finally {
      setQueryLoading(false);
    }
  }

  function handleQueryKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      runQuery();
    }
  }

  function formatCellValue(val: unknown): string {
    if (val === null || val === undefined) return "NULL";
    if (typeof val === "object") return JSON.stringify(val);
    return String(val);
  }

  function truncate(str: string, max: number): string {
    if (str.length <= max) return str;
    return str.slice(0, max) + "...";
  }

  if (!dbAvailable) {
    return (
      <div className="panel-placeholder">
        <div className="panel-title">Database</div>
        <div className="panel-desc">No database connection configured.</div>
      </div>
    );
  }

  const totalPages = Math.ceil(rowCount / PAGE_SIZE);

  return (
    <div className="db-viewer">
      <div className="db-toolbar">
        <button
          className={`db-toolbar-btn ${view === "browse" ? "active" : ""}`}
          onClick={() => setView("browse")}
        >
          Tables
        </button>
        <button
          className={`db-toolbar-btn ${view === "query" ? "active" : ""}`}
          onClick={() => setView("query")}
        >
          Query
        </button>
        <button className="db-toolbar-btn db-refresh" onClick={loadTables}>
          Refresh
        </button>
      </div>

      {view === "browse" ? (
        <div className="db-browse">
          <div className="db-sidebar">
            <div className="db-sidebar-header">Tables ({tables.length})</div>
            {tables.length === 0 && (
              <div className="db-sidebar-empty">No tables found</div>
            )}
            {tables.map((t) => (
              <button
                key={`${t.table_schema}.${t.table_name}`}
                className={`db-table-btn ${selectedTable === t.table_name ? "active" : ""}`}
                onClick={() => selectTable(t.table_name)}
              >
                <span className="db-table-icon">&#9638;</span>
                <span className="db-table-name">{t.table_name}</span>
                {t.table_schema !== "public" && (
                  <span className="db-table-schema">{t.table_schema}</span>
                )}
              </button>
            ))}
          </div>

          <div className="db-main">
            {!selectedTable && (
              <div className="db-empty-state">
                Select a table to browse its data
              </div>
            )}

            {selectedTable && (
              <>
                <div className="db-table-header">
                  <span className="db-table-title">{selectedTable}</span>
                  <span className="db-row-count">{rowCount} rows</span>
                </div>

                {columns.length > 0 && (
                  <div className="db-schema-strip">
                    {columns.map((col) => (
                      <span key={col.column_name} className="db-col-badge">
                        <span className="db-col-name">{col.column_name}</span>
                        <span className="db-col-type">{col.data_type}</span>
                        {col.is_nullable === "NO" && <span className="db-col-nn">NN</span>}
                      </span>
                    ))}
                  </div>
                )}

                {error && <div className="db-error">{error}</div>}

                {loading ? (
                  <div className="db-loading">Loading...</div>
                ) : (
                  <div className="db-data-grid-wrapper">
                    <div className="db-data-grid">
                      <table>
                        <thead>
                          <tr>
                            {columns.map((col) => (
                              <th key={col.column_name}>{col.column_name}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {rows.length === 0 ? (
                            <tr>
                              <td colSpan={columns.length} className="db-no-rows">
                                No rows
                              </td>
                            </tr>
                          ) : (
                            rows.map((row, i) => (
                              <tr key={i}>
                                {columns.map((col) => (
                                  <td key={col.column_name} title={formatCellValue(row[col.column_name])}>
                                    <span className={row[col.column_name] === null ? "db-null" : ""}>
                                      {truncate(formatCellValue(row[col.column_name]), 100)}
                                    </span>
                                  </td>
                                ))}
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {totalPages > 1 && (
                  <div className="db-pagination">
                    <button
                      disabled={page === 0}
                      onClick={() => loadPage(page - 1)}
                    >
                      Prev
                    </button>
                    <span className="db-page-info">
                      Page {page + 1} of {totalPages}
                    </span>
                    <button
                      disabled={page >= totalPages - 1}
                      onClick={() => loadPage(page + 1)}
                    >
                      Next
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      ) : (
        <div className="db-query-view">
          <div className="db-query-input">
            <textarea
              ref={textareaRef}
              className="db-query-editor"
              value={sql}
              onChange={(e) => setSql(e.target.value)}
              onKeyDown={handleQueryKeyDown}
              placeholder="SELECT * FROM table_name LIMIT 50"
              spellCheck={false}
            />
            <div className="db-query-actions">
              <button
                className="db-run-btn"
                onClick={runQuery}
                disabled={queryLoading || !sql.trim()}
              >
                {queryLoading ? "Running..." : "Run Query"}
              </button>
              <span className="db-query-hint">Ctrl+Enter to run</span>
            </div>
          </div>

          {queryError && <div className="db-error">{queryError}</div>}

          {queryResult && (
            <div className="db-query-results">
              <div className="db-query-meta">
                {queryResult.rowCount} row{queryResult.rowCount !== 1 ? "s" : ""} returned in {queryResult.duration}ms
              </div>
              {queryResult.rows.length > 0 && (
                <div className="db-data-grid-wrapper">
                  <div className="db-data-grid">
                    <table>
                      <thead>
                        <tr>
                          {Object.keys(queryResult.rows[0]).map((key) => (
                            <th key={key}>{key}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {queryResult.rows.map((row, i) => (
                          <tr key={i}>
                            {Object.keys(queryResult.rows[0]).map((key) => (
                              <td key={key} title={formatCellValue(row[key])}>
                                <span className={row[key] === null ? "db-null" : ""}>
                                  {truncate(formatCellValue(row[key]), 100)}
                                </span>
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
