import { useState, useEffect, useCallback } from "react";
import type { ProjectData } from "../App";

// ── Types ─────────────────────────────────────────────────────────────────────

interface PublishStatus {
  published: boolean;
  projectId?: string;
  slug?: string;
  port?: number;
  status?: string;
  publishedAt?: number;
  renderUrl?: string;
  logs?: string;
  github?: { commitSha?: string; commitUrl?: string; filesCount?: number };
  customDomain?: string | null;
  customDomainId?: string | null;
  customDomainStatus?: string | null;
  customDomainARecord?: string | null;
  customDomainCname?: string | null;
}

interface Tab {
  id: string;
  label: string;
  description: string;
}

const defaultTabs: Tab[] = [
  { id: "files",   label: "Files",   description: "Live GitHub file tree for this project branch." },
  { id: "commits", label: "Commits", description: "Git history with one-click rollback." },
  { id: "render",  label: "Render",  description: "Live app at *.forge-os.ai." },
  { id: "env",     label: "Env",     description: "Project environment variables." },
  { id: "publish", label: "Publish", description: "Deployment controls, domains, and subdomain management." },
  { id: "brain",   label: "Brain",   description: "Persistent team memory — patterns, preferences, and project history." },
];

interface WorkspaceProps {
  runData?: null;
  projectData?: ProjectData | null;
  viewingIterationRunId?: string | null;
  onRefreshRunData?: () => void;
}

// ── Publish Tab ───────────────────────────────────────────────────────────────

function PublishTab({ projectId }: { projectId: string | null }) {
  const [pubStatus, setPubStatus] = useState<PublishStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [confirmUnpublish, setConfirmUnpublish] = useState(false);
  const [slugEdit, setSlugEdit] = useState("");
  const [renamingSlug, setRenamingSlug] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [domainInput, setDomainInput] = useState("");
  const [savingDomain, setSavingDomain] = useState(false);
  const [, setDomainResult] = useState<null>(null);
  const [copiedDns, setCopiedDns] = useState(false);

  const fetchStatus = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/publish`);
      const data = await res.json();
      setPubStatus(data);
      setSlugEdit(data.slug || "");
    } catch {
      setPubStatus({ published: false });
    }
    setLoading(false);
  }, [projectId]);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  const [githubResult, setGithubResult] = useState<PublishStatus["github"]>(undefined);

  const handlePublish = async () => {
    if (!projectId) return;
    setPublishing(true);
    setError(null);
    setGithubResult(undefined);
    try {
      const res = await fetch(`/api/projects/${projectId}/publish`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Publish failed");
      if (data.github) setGithubResult(data.github);
      if (data.githubError) setError((prev) => (prev ? prev + " | GitHub: " + data.githubError : "GitHub push failed: " + data.githubError));
      await fetchStatus();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Publish failed");
    }
    setPublishing(false);
  };

  const handleUnpublish = async () => {
    if (!projectId) return;
    try {
      await fetch(`/api/projects/${projectId}/publish`, { method: "DELETE" });
      setConfirmUnpublish(false);
      await fetchStatus();
    } catch {
      setError("Failed to unpublish");
    }
  };

  const handleRenameSlug = async () => {
    if (!slugEdit || slugEdit === pubStatus?.slug) return;
    setRenamingSlug(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/slug`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: slugEdit }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      await fetchStatus();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setRenamingSlug(false);
    }
  };

  const handleSaveDomain = async () => {
    if (!projectId || !domainInput.trim()) return;
    setSavingDomain(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/custom-domain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: domainInput.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setDomainResult(data);
      await fetchStatus();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSavingDomain(false);
    }
  };

  const handleRemoveDomain = async () => {
    if (!projectId) return;
    try {
      await fetch(`/api/projects/${projectId}/custom-domain`, { method: "DELETE" });
      setDomainResult(null);
      setDomainInput("");
      await fetchStatus();
    } catch {
      setError("Failed to remove custom domain");
    }
  };

  const handleCopyDns = (val: string) => {
    navigator.clipboard.writeText(val);
    setCopiedDns(true);
    setTimeout(() => setCopiedDns(false), 2000);
  };

  const handleExport = () => {
    if (!projectId) return;
    window.open(`/api/projects/${projectId}/export`, "_blank");
  };

  const handleCopy = (url: string) => {
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!projectId) {
    return (
      <div className="panel-placeholder">
        <div className="panel-title">Publish</div>
        <div className="panel-desc">Select a project first.</div>
      </div>
    );
  }

  if (loading && !pubStatus) {
    return (
      <div className="panel-placeholder">
        <div className="panel-desc">Loading publish status...</div>
      </div>
    );
  }

  const isPublished = pubStatus?.published && (pubStatus.status === "running" || pubStatus.status === "deploying");
  const subdomainUrl = pubStatus?.slug ? `https://${pubStatus.slug}.forge-os.ai` : "";
  const appUrl = subdomainUrl || pubStatus?.renderUrl || "";

  return (
    <div className="pub-container">
      <div className="pub-header">
        <h2 className="pub-title">Publish</h2>
        <p className="pub-subtitle">
          {isPublished
            ? "Your app is live and publicly accessible."
            : "Publish your app to make it publicly accessible."}
        </p>
      </div>

      {error && <div className="pub-error">{error}</div>}

      {isPublished ? (
        <div className="pub-live-section">
          <div className="pub-status-row">
            <span className="pub-status-dot pub-status-running" />
            <span className="pub-status-text">Live</span>
            {pubStatus?.publishedAt && (
              <span className="pub-status-time">
                Published {new Date(pubStatus.publishedAt).toLocaleString()}
              </span>
            )}
          </div>

          <div className="pub-url-section">
            <label className="pub-url-label">Public URL</label>
            <div className="pub-url-row">
              <a href={appUrl} target="_blank" rel="noopener noreferrer" className="pub-url-link">
                {appUrl}
              </a>
              <button className="pub-copy-btn" onClick={() => handleCopy(appUrl)}>
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
          </div>

          <div className="pub-url-section">
            <label className="pub-url-label">App Slug</label>
            <div className="pub-slug-row">
              <input
                className="pub-slug-input"
                value={slugEdit}
                onChange={e => setSlugEdit(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                placeholder="my-app-name"
              />
              <button
                className="pub-copy-btn"
                onClick={handleRenameSlug}
                disabled={slugEdit === pubStatus?.slug || renamingSlug}
              >
                {renamingSlug ? "Saving..." : "Save"}
              </button>
            </div>
            <div className="pub-slug-preview">{slugEdit}.forge-os.ai</div>
            {slugEdit !== pubStatus?.slug && (
              <div className="pub-slug-warning">⚠ Renaming will create a new Render service and delete the old one.</div>
            )}
          </div>

          <div className="pub-url-section">
            <label className="pub-url-label">Custom Domain</label>
            {pubStatus?.customDomain ? (
              <div className="pub-domain-active">
                <div className="pub-domain-row">
                  <span className="pub-domain-name">{pubStatus.customDomain}</span>
                  <span className={`pub-domain-badge ${pubStatus.customDomainStatus === "verified" ? "pub-domain-verified" : "pub-domain-pending"}`}>
                    {pubStatus.customDomainStatus === "verified" ? "✓ Verified" : "⏳ Pending DNS"}
                  </span>
                  <button className="pub-domain-remove" onClick={handleRemoveDomain}>Remove</button>
                </div>
                {(pubStatus?.customDomainARecord || pubStatus?.customDomainCname) && (
                  <div className="pub-dns-instructions">
                    <div className="pub-dns-label">Add this DNS record at Namecheap:</div>
                    {pubStatus.customDomainARecord ? (
                      <div className="pub-dns-record">
                        <span className="pub-dns-type">A Record</span>
                        <span className="pub-dns-host">@</span>
                        <span className="pub-dns-value">{pubStatus.customDomainARecord}</span>
                        <button className="pub-copy-btn" onClick={() => handleCopyDns(pubStatus.customDomainARecord!)}>
                          {copiedDns ? "Copied!" : "Copy"}
                        </button>
                      </div>
                    ) : (
                      <div className="pub-dns-record">
                        <span className="pub-dns-type">CNAME</span>
                        <span className="pub-dns-host">www</span>
                        <span className="pub-dns-value">{pubStatus.customDomainCname}</span>
                        <button className="pub-copy-btn" onClick={() => handleCopyDns(pubStatus.customDomainCname!)}>
                          {copiedDns ? "Copied!" : "Copy"}
                        </button>
                      </div>
                    )}
                    <div className="pub-dns-note">TLS certificate will provision automatically once DNS propagates (5–30 min).</div>
                  </div>
                )}
              </div>
            ) : (
              <div className="pub-domain-input-row">
                <input
                  className="pub-slug-input"
                  value={domainInput}
                  onChange={e => setDomainInput(e.target.value.toLowerCase())}
                  placeholder="sandbox-xm.com"
                />
                <button
                  className="pub-copy-btn"
                  onClick={handleSaveDomain}
                  disabled={savingDomain || !domainInput.trim()}
                >
                  {savingDomain ? "Saving..." : "Add"}
                </button>
              </div>
            )}
          </div>

          {githubResult?.commitUrl && (
            <div className="pub-github-section">
              <label className="pub-url-label">GitHub</label>
              <div className="pub-url-row">
                <a href={githubResult.commitUrl} target="_blank" rel="noopener noreferrer" className="pub-url-link">
                  {githubResult.commitSha?.slice(0, 7)} — {githubResult.filesCount} files pushed
                </a>
              </div>
            </div>
          )}

          <div className="pub-actions">
            <button className="pub-republish-btn" onClick={handlePublish} disabled={publishing}>
              {publishing ? "Republishing..." : "Republish"}
            </button>
            <button className="pub-export-btn" onClick={handleExport}>
              Export ZIP
            </button>
            {!confirmUnpublish ? (
              <button className="pub-unpublish-btn" onClick={() => setConfirmUnpublish(true)}>
                Unpublish
              </button>
            ) : (
              <button className="pub-unpublish-confirm" onClick={handleUnpublish}>
                Confirm Unpublish
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="pub-unpublished-section">
          {pubStatus?.published && pubStatus.status === "failed" && (
            <div className="pub-failed-notice">
              Previous publish failed. Check logs and try again.
              {pubStatus.logs && (
                <pre className="pub-failed-logs">{pubStatus.logs.slice(-2000)}</pre>
              )}
            </div>
          )}
          <div className="pub-actions">
            <button className="pub-publish-btn" onClick={handlePublish} disabled={publishing}>
              {publishing ? "Publishing..." : "Publish App"}
            </button>
            <button className="pub-export-btn" onClick={handleExport}>
              Export ZIP
            </button>
          </div>
          <p className="pub-info">
            Publishing pushes your code to a public URL on forge-os.ai.
            Forge writes directly to GitHub and Render deploys automatically.
          </p>
        </div>
      )}
    </div>
  );
}

// ── Files Tab ─────────────────────────────────────────────────────────────────

interface GitHubFile {
  name: string;
  path: string;
  type: "file" | "dir";
  size?: number;
}

function FilesTab({ projectId, slug }: { projectId: string | null; slug?: string | null }) {
  const [files, setFiles] = useState<GitHubFile[]>([]);
  const [currentPath, setCurrentPath] = useState("");
  const [pathHistory, setPathHistory] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const branch = slug ? `apps/${slug}` : null;

  const fetchDir = useCallback(async (path: string) => {
    if (!branch) return;
    setLoading(true);
    setError(null);
    setSelectedFile(null);
    setFileContent(null);
    try {
      const res = await fetch(`/api/github/ls?branch=${encodeURIComponent(branch)}&path=${encodeURIComponent(path)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to list files");
      setFiles(Array.isArray(data) ? data : []);
      setCurrentPath(path);
    } catch (err: any) {
      setError(err.message);
      setFiles([]);
    }
    setLoading(false);
  }, [branch]);

  useEffect(() => {
    if (branch) {
      setCurrentPath("");
      setPathHistory([]);
      setFiles([]);
      setSelectedFile(null);
      setFileContent(null);
      fetchDir("");
    }
  }, [branch, fetchDir]);

  const navigateInto = (dir: GitHubFile) => {
    setPathHistory(prev => [...prev, currentPath]);
    fetchDir(dir.path);
  };

  const navigateBack = () => {
    const prev = [...pathHistory];
    const backPath = prev.pop() ?? "";
    setPathHistory(prev);
    fetchDir(backPath);
  };

  const openFile = async (file: GitHubFile) => {
    if (!branch) return;
    setSelectedFile(file.path);
    setLoadingFile(true);
    setFileContent(null);
    try {
      const res = await fetch(`/api/github/read?branch=${encodeURIComponent(branch)}&path=${encodeURIComponent(file.path)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to read file");
      setFileContent(data.content || "");
    } catch (err: any) {
      setFileContent(`Error: ${err.message}`);
    }
    setLoadingFile(false);
  };

  if (!projectId || !slug) {
    return (
      <div className="panel-placeholder">
        <div className="panel-title">Files</div>
        <div className="panel-desc">Publish this project first to create its GitHub branch.</div>
      </div>
    );
  }

  const sortedFiles = [...files].sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <div className="files-tab">
      <div className="files-sidebar">
        <div className="files-header">
          <div className="files-branch-badge">
            <span className="files-branch-icon">⎇</span>
            <span className="files-branch-name">{branch}</span>
          </div>
          {currentPath && (
            <button className="files-back-btn" onClick={navigateBack}>
              ← Back
            </button>
          )}
          {currentPath && (
            <div className="files-current-path">/{currentPath}</div>
          )}
        </div>

        {error && <div className="files-error">{error}</div>}

        {loading ? (
          <div className="files-loading">Loading...</div>
        ) : (
          <div className="files-list">
            {sortedFiles.length === 0 && !loading && (
              <div className="files-empty">No files found. Ask Forge to build something.</div>
            )}
            {sortedFiles.map(f => (
              <div
                key={f.path}
                className={`files-row ${f.type === "dir" ? "files-row-dir" : "files-row-file"} ${selectedFile === f.path ? "active" : ""}`}
                onClick={() => f.type === "dir" ? navigateInto(f) : openFile(f)}
              >
                <span className="files-icon">{f.type === "dir" ? "📁" : "📄"}</span>
                <span className="files-name">{f.name}</span>
                {f.type === "file" && f.size != null && (
                  <span className="files-size">{f.size < 1024 ? `${f.size}B` : `${(f.size / 1024).toFixed(1)}KB`}</span>
                )}
                {f.type === "dir" && <span className="files-arrow">›</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="files-viewer">
        {!selectedFile ? (
          <div className="files-viewer-placeholder">
            <div className="files-viewer-icon">📂</div>
            <div className="files-viewer-hint">Select a file to view its contents</div>
            <div className="files-viewer-sub">Ask Forge in the chat to make changes</div>
          </div>
        ) : loadingFile ? (
          <div className="files-viewer-loading">Loading {selectedFile}...</div>
        ) : (
          <div className="files-viewer-content">
            <div className="files-viewer-header">
              <span className="files-viewer-filename">{selectedFile}</span>
              <a
                href={`https://github.com/BrianBMorgan/ForgeOS/blob/${branch}/${selectedFile}`}
                target="_blank"
                rel="noopener noreferrer"
                className="files-viewer-github-link"
              >
                View on GitHub ↗
              </a>
            </div>
            <pre className="files-viewer-code">{fileContent}</pre>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Commits Tab ───────────────────────────────────────────────────────────────

interface GitCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
}

function CommitsTab({ projectId, slug }: { projectId: string | null; slug?: string | null }) {
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [loading, setLoading] = useState(false);
  const [rollingBack, setRollingBack] = useState<string | null>(null);
  const [rollbackMsg, setRollbackMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const branch = slug ? `apps/${slug}` : null;

  const fetchCommits = useCallback(async () => {
    if (!branch) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/github/commits?branch=${encodeURIComponent(branch)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load commits");
      setCommits(Array.isArray(data) ? data : []);
    } catch (err: any) {
      setError(err.message);
    }
    setLoading(false);
  }, [branch]);

  useEffect(() => {
    if (branch) fetchCommits();
  }, [branch, fetchCommits]);

  const handleRollback = async (sha: string, _message: string) => {
    if (!projectId) return;
    setRollingBack(sha);
    setRollbackMsg(null);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/rollback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag: sha.slice(0, 7), commitSha: sha }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Rollback failed");
      setRollbackMsg(`Rolled back to ${sha.slice(0, 7)} — Render is redeploying.`);
    } catch (err: any) {
      setError(err.message);
    }
    setRollingBack(null);
  };

  if (!projectId || !slug) {
    return (
      <div className="panel-placeholder">
        <div className="panel-title">Commits</div>
        <div className="panel-desc">Publish this project first to see its commit history.</div>
      </div>
    );
  }

  return (
    <div className="commits-tab">
      <div className="commits-header">
        <div className="commits-branch-badge">
          <span className="files-branch-icon">⎇</span>
          <span className="files-branch-name">{branch}</span>
        </div>
        <button className="commits-refresh-btn" onClick={fetchCommits} disabled={loading}>
          {loading ? "Loading..." : "↻ Refresh"}
        </button>
      </div>

      {error && <div className="commits-error">{error}</div>}
      {rollbackMsg && <div className="commits-success">{rollbackMsg}</div>}

      {loading && commits.length === 0 ? (
        <div className="commits-loading">Loading commit history...</div>
      ) : commits.length === 0 ? (
        <div className="commits-empty">No commits yet. Ask Forge to build something.</div>
      ) : (
        <div className="commits-list">
          {commits.map((commit, i) => (
            <div key={commit.sha} className={`commits-row ${i === 0 ? "commits-row-latest" : ""}`}>
              <div className="commits-row-left">
                <div className="commits-sha">
                  <a
                    href={`https://github.com/BrianBMorgan/ForgeOS/commit/${commit.sha}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="commits-sha-link"
                  >
                    {commit.sha.slice(0, 7)}
                  </a>
                  {i === 0 && <span className="commits-latest-badge">HEAD</span>}
                </div>
                <div className="commits-message">{commit.message.split("\n")[0].slice(0, 100)}</div>
                <div className="commits-meta">
                  <span className="commits-author">{commit.author}</span>
                  <span className="commits-date">{new Date(commit.date).toLocaleString()}</span>
                </div>
              </div>
              <div className="commits-row-right">
                {i > 0 && (
                  <button
                    className="commits-rollback-btn"
                    onClick={() => handleRollback(commit.sha, commit.message)}
                    disabled={rollingBack !== null}
                    title={`Roll back to ${commit.sha.slice(0, 7)}`}
                  >
                    {rollingBack === commit.sha ? "Rolling back..." : "↩ Restore"}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Render Tab ────────────────────────────────────────────────────────────────

function RenderTab({ projectId, slug }: { projectId: string | null; slug?: string | null }) {
  const [deployStatus, setDeployStatus] = useState<{ status: string; url: string; lastDeploy: string; commit: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [redeploying, setRedeploying] = useState(false);
  const appUrl = slug ? `https://${slug}.forge-os.ai` : null;

  const fetchStatus = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/publish`);
      const data = await res.json();
      if (data.published) {
        setDeployStatus({
          status: data.status || "unknown",
          url: appUrl || data.renderUrl || "",
          lastDeploy: data.publishedAt ? new Date(data.publishedAt).toLocaleString() : "—",
          commit: data.github?.commitSha?.slice(0, 7) || "—",
        });
      } else {
        setDeployStatus(null);
      }
    } catch {
      setDeployStatus(null);
    }
    setLoading(false);
  }, [projectId, appUrl]);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  const handleRedeploy = async () => {
    if (!projectId) return;
    setRedeploying(true);
    try {
      await fetch(`/api/projects/${projectId}/publish`, { method: "POST" });
      setTimeout(fetchStatus, 2000);
    } catch {}
    setRedeploying(false);
  };

  if (!projectId) {
    return (
      <div className="panel-placeholder">
        <div className="panel-title">Render</div>
        <div className="panel-desc">Select a project to see deploy status.</div>
      </div>
    );
  }

  if (loading && !deployStatus) {
    return (
      <div className="panel-placeholder">
        <div className="panel-desc">Loading deploy status...</div>
      </div>
    );
  }

  if (!deployStatus) {
    return (
      <div className="panel-placeholder">
        <div className="panel-title">Render</div>
        <div className="panel-desc">This project hasn't been published yet. Go to the Publish tab to deploy it.</div>
        <button
          className="render-goto-publish"
          onClick={() => window.dispatchEvent(new CustomEvent("forgeos:switch-tab", { detail: "publish" }))}
        >
          Go to Publish →
        </button>
      </div>
    );
  }

  const isLive = deployStatus.status === "running";
  const isDeploying = deployStatus.status === "deploying";

  return (
    <div className="render-v2-container">
      <div className="render-v2-header">
        <div className="render-v2-status-row">
          <span className={`render-v2-dot ${isLive ? "render-v2-dot-live" : isDeploying ? "render-v2-dot-deploying" : "render-v2-dot-offline"}`} />
          <span className="render-v2-status-text">
            {isLive ? "Live" : isDeploying ? "Deploying..." : deployStatus.status}
          </span>
          <span className="render-v2-deploy-time">{deployStatus.lastDeploy}</span>
        </div>
        <button className="render-v2-redeploy-btn" onClick={handleRedeploy} disabled={redeploying}>
          {redeploying ? "Triggering..." : "↻ Redeploy"}
        </button>
      </div>

      {appUrl && (
        <div className="render-v2-url-card">
          <div className="render-v2-url-label">Live URL</div>
          <div className="render-v2-url-row">
            <a href={appUrl} target="_blank" rel="noopener noreferrer" className="render-v2-url-link">
              {appUrl}
            </a>
            <button
              className="pub-copy-btn"
              onClick={() => { navigator.clipboard.writeText(appUrl); }}
            >
              Copy
            </button>
            <a href={appUrl} target="_blank" rel="noopener noreferrer" className="render-v2-open-btn">
              Open ↗
            </a>
          </div>
        </div>
      )}

      {appUrl && isLive && (
        <div className="render-v2-iframe-wrap">
          <div className="render-v2-iframe-bar">
            <span className="render-v2-iframe-url">{appUrl}</span>
          </div>
          <iframe
            src={appUrl}
            className="render-v2-iframe"
            title="Live App"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          />
        </div>
      )}

      {isDeploying && (
        <div className="render-v2-deploying-notice">
          <div className="render-v2-deploying-spinner" />
          <span>Render is deploying your latest push. This usually takes 1–2 minutes.</span>
        </div>
      )}
    </div>
  );
}

// ── Env Tab ───────────────────────────────────────────────────────────────────

function EnvTab({ projectId }: { projectId: string | null }) {
  const [envVars, setEnvVars] = useState<{ key: string; value: string; createdAt: number }[]>([]);
  const [globalDefaults, setGlobalDefaults] = useState<{ key: string; value: string }[]>([]);
  const [globalSecretKeys, setGlobalSecretKeys] = useState<string[]>([]);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(new Set());

  const fetchEnvVars = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const [envRes, settingsRes, secretsRes] = await Promise.all([
        fetch(`/api/projects/${projectId}/env`),
        fetch("/api/settings"),
        fetch("/api/secrets"),
      ]);
      const envData = await envRes.json();
      const settingsData = await settingsRes.json();
      const secretsData = await secretsRes.json();
      setEnvVars(envData.envVars || []);
      setGlobalDefaults(settingsData?.default_env_vars?.vars || []);
      setGlobalSecretKeys(secretsData?.secrets || []);
      setError(null);
    } catch {
      setError("Failed to load environment variables");
    }
    setLoading(false);
  }, [projectId]);

  useEffect(() => { fetchEnvVars(); }, [fetchEnvVars]);

  const handleAdd = async () => {
    if (!projectId || !newKey.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/env`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: newKey.trim(), value: newValue }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to save");
      } else {
        setNewKey("");
        setNewValue("");
        await fetchEnvVars();
      }
    } catch {
      setError("Failed to save environment variable");
    }
    setSaving(false);
  };

  const handleDelete = async (key: string) => {
    if (!projectId) return;
    try {
      await fetch(`/api/projects/${projectId}/env/${encodeURIComponent(key)}`, { method: "DELETE" });
      await fetchEnvVars();
    } catch {
      setError("Failed to delete environment variable");
    }
  };

  const toggleVisibility = (key: string) => {
    setVisibleKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (!projectId) {
    return (
      <div className="panel-placeholder">
        <div className="panel-title">Environment Variables</div>
        <div className="panel-desc">No project selected.</div>
      </div>
    );
  }

  return (
    <div className="env-tab">
      <div className="env-header">
        <div className="env-title">Environment Variables</div>
        <div className="env-subtitle">
          Project-specific env vars injected into the Render service at deploy time.
        </div>
      </div>

      {error && <div className="env-error">{error}</div>}

      <div className="env-add-form">
        <input
          className="env-input env-key-input"
          placeholder="KEY_NAME"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))}
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
        />
        <input
          className="env-input env-value-input"
          placeholder="value"
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
        />
        <button className="env-add-btn" onClick={handleAdd} disabled={saving || !newKey.trim()}>
          {saving ? "Saving..." : "Add"}
        </button>
      </div>

      {loading ? (
        <div className="env-loading">Loading...</div>
      ) : envVars.length === 0 ? (
        <div className="env-empty">No project env vars set. Add one above.</div>
      ) : (
        <div className="env-list">
          {envVars.map((v) => (
            <div className="env-row" key={v.key}>
              <span className="env-row-key">{v.key}</span>
              <span className="env-row-value">
                {visibleKeys.has(v.key) ? v.value : "••••••••"}
              </span>
              <button className="env-row-toggle" onClick={() => toggleVisibility(v.key)} title={visibleKeys.has(v.key) ? "Hide" : "Show"}>
                {visibleKeys.has(v.key) ? "◉" : "○"}
              </button>
              <button className="env-row-delete" onClick={() => handleDelete(v.key)} title="Delete">✕</button>
            </div>
          ))}
        </div>
      )}

      {(globalDefaults.length > 0 || globalSecretKeys.length > 0) && (
        <div className="env-defaults-section">
          <div className="env-defaults-title">Inherited from Global Secrets Vault</div>
          <div className="env-defaults-desc">Auto-injected into all Render services. Project vars override globals with the same key.</div>
          <div className="env-defaults-list">
            {globalDefaults.map((v) => (
              <div className="env-default-item" key={`def-${v.key}`}>
                <span className="env-row-key">{v.key}</span>
                <span className="env-global-badge">Default</span>
                <span className="env-default-desc">{envVars.some((e) => e.key === v.key) ? "(overridden by project)" : ""}</span>
              </div>
            ))}
            {globalSecretKeys.map((key) => (
              <div className="env-default-item" key={`sec-${key}`}>
                <span className="env-row-key">{key}</span>
                <span className="env-global-badge secret">Secret</span>
                <span className="env-default-desc">{envVars.some((e) => e.key === key) ? "(overridden by project)" : ""}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Brain Tab ─────────────────────────────────────────────────────────────────

interface BrainData {
  totals: { projects: number; preferences: number; patterns: number; mistakes: number; snippets: number; embedded?: number };
  topMistakes: { content: string; usefulness_score: number }[];
  recentProjects: { name: string; description: string; stack: string[] | null; published_url: string | null }[];
}

function BrainTab() {
  const [data, setData] = useState<BrainData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/brain");
        if (!res.ok) throw new Error("Failed to load brain data");
        const json = await res.json();
        if (!cancelled) setData(json);
      } catch (err: unknown) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  if (loading) return <div className="panel-placeholder"><div className="panel-title">Brain</div><div className="panel-desc">Loading memory...</div></div>;
  if (error) return <div className="panel-placeholder"><div className="panel-title">Brain</div><div className="panel-desc">{error}</div></div>;
  if (!data) return null;

  const { totals, topMistakes, recentProjects } = data;

  return (
    <div className="brain-container">
      <div className="brain-header">
        <h2 className="brain-title">ForgeOS Brain</h2>
        <p className="brain-subtitle">Persistent team memory — learns from every build</p>
      </div>

      <div className="brain-stats-grid">
        <div className="brain-stat"><span className="brain-stat-value">{totals.projects}</span><span className="brain-stat-label">Projects Built</span></div>
        <div className="brain-stat"><span className="brain-stat-value">{totals.patterns}</span><span className="brain-stat-label">Patterns Learned</span></div>
        <div className="brain-stat"><span className="brain-stat-value">{totals.mistakes}</span><span className="brain-stat-label">Mistakes Tracked</span></div>
        <div className="brain-stat"><span className="brain-stat-value">{totals.preferences}</span><span className="brain-stat-label">Team Preferences</span></div>
        <div className="brain-stat"><span className="brain-stat-value">{totals.snippets}</span><span className="brain-stat-label">Code Snippets</span></div>
        <div className="brain-stat"><span className="brain-stat-value">{totals.embedded || 0}</span><span className="brain-stat-label">Embeddings</span></div>
      </div>

      {recentProjects.length > 0 && (
        <div className="brain-section">
          <h3 className="brain-section-title">Project Index</h3>
          <div className="brain-projects">
            {recentProjects.map((p, i) => (
              <div key={i} className="brain-project-card">
                <div className="brain-project-name">{p.name}</div>
                {p.description && <div className="brain-project-desc">{p.description}</div>}
                <div className="brain-project-meta">
                  {p.stack && p.stack.length > 0 && (
                    <div className="brain-project-stack">
                      {(Array.isArray(p.stack) ? p.stack : []).map((s, j) => (
                        <span key={j} className="brain-stack-tag">{s}</span>
                      ))}
                    </div>
                  )}
                  {p.published_url && (
                    <a href={p.published_url} target="_blank" rel="noopener noreferrer" className="brain-project-link">Live</a>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {topMistakes.length > 0 && (
        <div className="brain-section">
          <h3 className="brain-section-title">Top Mistakes Learned</h3>
          <div className="brain-mistakes">
            {topMistakes.map((m, i) => (
              <div key={i} className="brain-mistake-item">
                <span className="brain-mistake-score">{m.usefulness_score}</span>
                <span className="brain-mistake-text">{m.content}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {totals.projects === 0 && totals.patterns === 0 && totals.mistakes === 0 && (
        <div className="brain-empty">
          <div className="brain-empty-title">Brain is empty</div>
          <div className="brain-empty-desc">Run your first build to start teaching ForgeOS.</div>
        </div>
      )}
    </div>
  );
}

// ── Main Workspace ────────────────────────────────────────────────────────────

export default function Workspace({ projectData }: WorkspaceProps) {
  const [activeTab, setActiveTab] = useState("files");
  const [resolvedSlug, setResolvedSlug] = useState<string | null>(null);

  useEffect(() => {
    const handler = (e: CustomEvent) => setActiveTab(e.detail);
    window.addEventListener("forgeos:switch-tab", handler as EventListener);
    return () => window.removeEventListener("forgeos:switch-tab", handler as EventListener);
  }, []);

  const projectId = projectData?.id || null;

  // Fetch slug from publish status — slug lives in published_apps, not projects table
  useEffect(() => {
    if (!projectId) { setResolvedSlug(null); return; }
    fetch(`/api/projects/${projectId}/publish`)
      .then(r => r.json())
      .then(d => setResolvedSlug(d.slug || null))
      .catch(() => setResolvedSlug(null));
  }, [projectId]);

  const slug = resolvedSlug;

  const renderTabContent = () => {
    switch (activeTab) {
      case "files":
        return <FilesTab projectId={projectId} slug={slug} />;
      case "commits":
        return <CommitsTab projectId={projectId} slug={slug} />;
      case "render":
        return <RenderTab projectId={projectId} slug={slug} />;
      case "env":
        return <EnvTab projectId={projectId} />;
      case "publish":
        return <PublishTab projectId={projectId} />;
      case "brain":
        return <BrainTab />;
      default:
        return (
          <div className="panel-placeholder">
            <div className="panel-title">{activeTab}</div>
          </div>
        );
    }
  };

  return (
    <div className="workspace-container">
      <div className="tab-bar">
        {defaultTabs.map((tab) => (
          <button
            key={tab.id}
            className={`tab-btn ${activeTab === tab.id ? "active" : ""}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className={`tab-panel${activeTab === "render" ? " tab-panel-render" : ""}`}>
        {renderTabContent()}
      </div>
    </div>
  );
}
