import { useState, useEffect, useRef } from "react";

export default function Assets() {
  const [assets, setAssets] = useState<any[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchAssets = async () => {
    try {
      const res = await fetch("/api/assets");
      const data = await res.json();
      setAssets(Array.isArray(data) ? data : []);
    } catch {}
  };

  useEffect(() => { fetchAssets(); }, []);

  const handleUpload = async (files: FileList | null) => {
    setUploading(true);
    setError(null);
    for (const file of Array.from(files || [])) {
      const formData = new FormData();
      formData.append("file", file);
      try {
        const res = await fetch("/api/assets", { method: "POST", body: formData });
        if (!res.ok) {
          const d = await res.json();
          setError(d.error || "Upload failed");
        }
      } catch (err: any) {
        setError(err.message);
      }
    }
    setUploading(false);
    fetchAssets();
  };

  const handleDelete = async (filename: string) => {
    await fetch(`/api/assets/${encodeURIComponent(filename)}`, { method: "DELETE" });
    fetchAssets();
  };

  const handleCopyUrl = (filename: string) => {
    navigator.clipboard.writeText(`/api/assets/${encodeURIComponent(filename)}`);
    setCopied(filename);
    setTimeout(() => setCopied(null), 1500);
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  };

  return (
    <div className="assets-container">
      <div className="assets-header">
        <h2 className="assets-title">Assets</h2>
        <p className="assets-subtitle">Global files available to all projects — images, CSVs, documents.</p>
      </div>
      {error && <div className="pub-error">{error}</div>}
      <div
        className="assets-dropzone"
        onClick={() => fileInputRef.current?.click()}
        onDragOver={e => e.preventDefault()}
        onDrop={e => { e.preventDefault(); handleUpload(e.dataTransfer.files); }}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: "none" }}
          value=""
          onChange={e => handleUpload(e.target.files)}
        />
        <div className="assets-dropzone-text">
          {uploading ? "Uploading..." : "Drop files here or click to upload"}
        </div>
        <div className="assets-dropzone-hint">Images, CSVs, JSON, text, PDF — max 10MB each</div>
      </div>
      {assets.length > 0 && (
        <div className="assets-list">
          {assets.map(a => (
            <div key={a.id} className="assets-item">
              <div className="assets-item-info">
                <span className="assets-item-name">{a.filename}</span>
                <span className="assets-item-meta">{a.mimetype} · {formatSize(a.size_bytes)}</span>
              </div>
              <div className="assets-item-actions">
                <button className="assets-btn" onClick={() => handleCopyUrl(a.filename)}>
                  {copied === a.filename ? "Copied!" : "Copy URL"}
                </button>
                <button className="assets-btn assets-btn-danger" onClick={() => handleDelete(a.filename)}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {assets.length === 0 && !uploading && (
        <div className="assets-empty">No assets uploaded yet.</div>
      )}
    </div>
  );
}
