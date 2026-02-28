import { useState, useEffect, useRef, useCallback } from "react";

interface StressTestStatus {
  running: boolean;
  currentPromptId: string | null;
  completed: number;
  total: number;
  results: PromptResult[];
  startedAt: number | null;
  finishedAt: number | null;
}

interface PromptResult {
  promptId: string;
  runId: string;
  category: string;
  prompt: string;
  finalStatus: string;
  totalDuration: number;
  error: string | null;
  violations: { rule: string; severity: string; file: string; line: number; snippet: string }[] | null;
  violationScore: number | null;
  healthCheck: { status: string; statusCode: number | null; bodySnippet: string } | null;
  executorOutput: {
    fileCount: number;
    filePaths: string[];
    installCommand: string | null;
    startCommand: string | null;
    port: number | null;
    implementationSummary: string;
  } | null;
  installResult: { success?: boolean; error?: string; logSnippet?: string } | null;
  startResult: { success?: boolean; error?: string; logSnippet?: string } | null;
}

interface Report {
  summary: {
    total: number;
    pass: number;
    passWithViolations: number;
    fail: number;
    timeout: number;
    error: number;
    successRate: number;
    totalDuration: number;
    avgDuration: number;
  };
  perPrompt: {
    promptId: string;
    category: string;
    finalStatus: string;
    violationCount: number;
    violationScore: number | null;
    totalDuration: number;
    error: string | null;
    healthCheck: { status: string; statusCode: number | null } | null;
  }[];
  violationFrequency: { rule: string; count: number }[];
  categoryAnalysis: { category: string; total: number; pass: number; fail: number; successRate: number }[];
  stageFailures: Record<string, { count: number; promptIds: string[] }>;
  suggestions: string[];
}

const API = "/api/stress-test";

const STATUS_COLORS: Record<string, string> = {
  pass: "#22c55e",
  pass_with_violations: "#eab308",
  fail_plan: "#ef4444",
  fail_install: "#f97316",
  fail_start: "#f97316",
  fail_health: "#ef4444",
  fail_violations: "#eab308",
  timeout: "#8b5cf6",
  error: "#ef4444",
  unknown: "#6b7280",
};

function StressTest() {
  const [status, setStatus] = useState<StressTestStatus | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API}/status`);
      if (res.ok) {
        const data: StressTestStatus = await res.json();
        setStatus(data);
        return data;
      }
    } catch {}
    return null;
  }, []);

  const fetchResults = useCallback(async () => {
    try {
      const res = await fetch(`${API}/results`);
      if (res.ok) {
        const data: Report = await res.json();
        setReport(data);
      }
    } catch {}
  }, []);

  useEffect(() => {
    fetchStatus();
    fetchResults();
  }, [fetchStatus, fetchResults]);

  useEffect(() => {
    if (status?.running) {
      pollRef.current = setInterval(async () => {
        const s = await fetchStatus();
        if (s && !s.running) {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          fetchResults();
        }
      }, 3000);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [status?.running, fetchStatus, fetchResults]);

  const startTest = async () => {
    setStarting(true);
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    try {
      await fetch(`${API}/start`, { method: "POST", headers: { "Content-Type": "application/json" } });
      await new Promise((r) => setTimeout(r, 1000));
      await fetchStatus();
    } catch {}
    setStarting(false);
  };

  const pct = status?.total ? Math.round(((status.completed || 0) / status.total) * 100) : 0;

  return (
    <div className="stress-test-container">
      <div className="stress-test-header">
        <h2>Executor Stress Test</h2>
        <p className="stress-test-desc">
          Run diverse prompts through the pipeline autonomously to find Executor weaknesses.
        </p>
      </div>

      <div className="stress-test-controls">
        <button
          className="stress-test-btn"
          onClick={startTest}
          disabled={status?.running || starting}
        >
          {status?.running ? "Running..." : starting ? "Starting..." : "Run Stress Test"}
        </button>

        {status?.running && (
          <div className="stress-test-progress">
            <div className="progress-bar-track">
              <div className="progress-bar-fill" style={{ width: `${pct}%` }} />
            </div>
            <span className="progress-label">
              {status.completed}/{status.total} ({pct}%)
              {status.currentPromptId && ` — ${status.currentPromptId}`}
            </span>
          </div>
        )}
      </div>

      {report && (
        <div className="stress-test-results">
          <div className="stress-test-summary">
            <div className="summary-card">
              <span className="summary-value">{report.summary.total}</span>
              <span className="summary-label">Total</span>
            </div>
            <div className="summary-card pass">
              <span className="summary-value">{report.summary.pass}</span>
              <span className="summary-label">Passed</span>
            </div>
            <div className="summary-card warn">
              <span className="summary-value">{report.summary.passWithViolations}</span>
              <span className="summary-label">w/ Violations</span>
            </div>
            <div className="summary-card fail">
              <span className="summary-value">{report.summary.fail}</span>
              <span className="summary-label">Failed</span>
            </div>
            <div className="summary-card">
              <span className="summary-value">{report.summary.timeout}</span>
              <span className="summary-label">Timeout</span>
            </div>
            <div className="summary-card">
              <span className="summary-value">{Math.round(report.summary.successRate)}%</span>
              <span className="summary-label">Success Rate</span>
            </div>
          </div>

          <div className="stress-test-section">
            <h3>Results by Prompt</h3>
            <table className="results-table">
              <thead>
                <tr>
                  <th>Prompt</th>
                  <th>Category</th>
                  <th>Status</th>
                  <th>Violations</th>
                  <th>Score</th>
                  <th>Duration</th>
                </tr>
              </thead>
              <tbody>
                {report.perPrompt.map((r) => (
                  <>
                    <tr
                      key={r.promptId}
                      className={`result-row ${expandedRow === r.promptId ? "expanded" : ""}`}
                      onClick={() => setExpandedRow(expandedRow === r.promptId ? null : r.promptId)}
                    >
                      <td className="prompt-cell">{r.promptId}</td>
                      <td><span className="category-tag">{r.category}</span></td>
                      <td>
                        <span
                          className="status-badge"
                          style={{ background: STATUS_COLORS[r.finalStatus] || STATUS_COLORS.unknown }}
                        >
                          {r.finalStatus}
                        </span>
                      </td>
                      <td>{r.violationCount}</td>
                      <td>{r.violationScore ?? "-"}</td>
                      <td>{(r.totalDuration / 1000).toFixed(1)}s</td>
                    </tr>
                    {expandedRow === r.promptId && (
                      <tr key={`${r.promptId}-details`} className="detail-row">
                        <td colSpan={6}>
                          <div className="detail-content">
                            {r.error && (
                              <div className="detail-section detail-error">
                                <strong>Error:</strong> {r.error}
                              </div>
                            )}
                            {r.healthCheck && (
                              <div className="detail-section">
                                <strong>Health Check:</strong> HTTP {r.healthCheck.statusCode || "N/A"} — {r.healthCheck.status}
                              </div>
                            )}
                            {(() => {
                              const full = status?.results?.find((sr: PromptResult) => sr.promptId === r.promptId);
                              if (!full) return null;
                              return (
                                <>
                                  <div className="detail-section">
                                    <strong>Prompt:</strong> {full.prompt}
                                  </div>
                                  {full.executorOutput && (
                                    <div className="detail-section">
                                      <strong>Files ({full.executorOutput.fileCount}):</strong>{" "}
                                      {full.executorOutput.filePaths.join(", ")}
                                      <br />
                                      <strong>Install:</strong> {full.executorOutput.installCommand || "none"}
                                      {" | "}
                                      <strong>Start:</strong> {full.executorOutput.startCommand || "none"}
                                      {" | "}
                                      <strong>Port:</strong> {full.executorOutput.port || "none"}
                                    </div>
                                  )}
                                  {full.violations && full.violations.length > 0 && (
                                    <div className="detail-section">
                                      <strong>Violations:</strong>
                                      <ul className="violation-list">
                                        {full.violations.map((v: { severity: string; rule: string; file: string; line: number; snippet: string }, i: number) => (
                                          <li key={i}>
                                            <span className={`severity-${v.severity}`}>[{v.severity}]</span>{" "}
                                            {v.rule} — {v.file}:{v.line} — <code>{v.snippet}</code>
                                          </li>
                                        ))}
                                      </ul>
                                    </div>
                                  )}
                                  {full.installResult?.logSnippet && (
                                    <div className="detail-section">
                                      <strong>Install Log:</strong>
                                      <pre className="log-snippet">{full.installResult.logSnippet}</pre>
                                    </div>
                                  )}
                                  {full.startResult?.logSnippet && (
                                    <div className="detail-section">
                                      <strong>App Log:</strong>
                                      <pre className="log-snippet">{full.startResult.logSnippet}</pre>
                                    </div>
                                  )}
                                </>
                              );
                            })()}
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>

          {report.violationFrequency.length > 0 && (
            <div className="stress-test-section">
              <h3>Most Common Violations</h3>
              <div className="violation-freq">
                {report.violationFrequency.map((v) => (
                  <div key={v.rule} className="freq-row">
                    <span className="freq-rule">{v.rule}</span>
                    <span className="freq-count">{v.count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {report.categoryAnalysis && report.categoryAnalysis.length > 0 && (
            <div className="stress-test-section">
              <h3>Success by Category</h3>
              <div className="category-grid">
                {report.categoryAnalysis.map((cat) => (
                  <div key={cat.category} className="category-card">
                    <span className="category-name">{cat.category}</span>
                    <span className="category-rate">{cat.successRate}%</span>
                    <span className="category-count">{cat.pass}/{cat.total}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {report.suggestions && report.suggestions.length > 0 && (
            <div className="stress-test-section">
              <h3>Suggested Instruction Improvements</h3>
              <ul className="suggestion-list">
                {report.suggestions.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {!report && !status?.running && (
        <div className="stress-test-empty">
          No results yet. Run a stress test to evaluate the Executor.
        </div>
      )}
    </div>
  );
}

export default StressTest;
