import { useState, useEffect, useCallback } from "react";

interface SettingValues {
  default_env_vars: { vars: { key: string; value: string }[] };
  github: { repo: string; autoPush: boolean };
}

interface Skill {
  id: number;
  name: string;
  description: string;
  instructions: string;
  tags: string;
  created_at: number;
  updated_at: number;
}

interface Brand {
  id: number;
  name: string;
  urls: string[];
  profile: string;
  lastScrapedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

const DEFAULT_SETTINGS: SettingValues = {
  default_env_vars: { vars: [] },
  github: { repo: "BrianBMorgan/ForgeOS", autoPush: true },
};

type TabId = "secrets" | "env_vars" | "github" | "skills" | "brands";

const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: "secrets", label: "Secrets Vault", icon: "⛓" },
  { id: "env_vars", label: "Default Env Vars", icon: "▧" },
  { id: "github", label: "GitHub", icon: "⊛" },
  { id: "skills", label: "Skills Library", icon: "◈" },
  { id: "brands", label: "Brands", icon: "◆" },
];

export default function Settings() {
  const [settings, setSettings] = useState<SettingValues>(DEFAULT_SETTINGS);
  const [secrets, setSecrets] = useState<string[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [activeTab, setActiveTab] = useState<TabId>("secrets");
  const [saving, setSaving] = useState<string | null>(null);
  const [newSecretKey, setNewSecretKey] = useState("");
  const [newSecretValue, setNewSecretValue] = useState("");
  const [newEnvKey, setNewEnvKey] = useState("");
  const [newEnvValue, setNewEnvValue] = useState("");
  const [editingSkill, setEditingSkill] = useState<Skill | null>(null);
  const [newSkill, setNewSkill] = useState(false);
  const [skillForm, setSkillForm] = useState({ name: "", description: "", instructions: "", tags: "" });
  const [importUrl, setImportUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const [selectedSkillId, setSelectedSkillId] = useState<number | null>(null);
  const [revealedSecrets, setRevealedSecrets] = useState<Record<string, string>>({});
  const [selectedBrandId, setSelectedBrandId] = useState<number | null>(null);
  const [newBrand, setNewBrand] = useState(false);
  const [brandForm, setBrandForm] = useState({ name: "", urlsText: "", profile: "" });
  const [brandBusy, setBrandBusy] = useState<string | null>(null);
  const [brandError, setBrandError] = useState("");

  const loadAll = useCallback(async () => {
    try {
      const [settingsRes, secretsRes, skillsRes, brandsRes] = await Promise.all([
        fetch("/api/settings"),
        fetch("/api/secrets"),
        fetch("/api/skills"),
        fetch("/api/brands"),
      ]);
      const settingsData = await settingsRes.json();
      const secretsData = await secretsRes.json();
      const skillsData = await skillsRes.json();
      const brandsData = await brandsRes.json();
      const merged = { ...DEFAULT_SETTINGS };
      if (settingsData && typeof settingsData === "object" && !Array.isArray(settingsData)) {
        for (const key of Object.keys(merged)) {
          if (key in settingsData) (merged as Record<string, unknown>)[key] = settingsData[key];
        }
      }
      setSettings(merged);
      setSecrets(secretsData.secrets || []);
      setSkills(skillsData.skills || []);
      setBrands(brandsData.brands || []);
    } catch (err) {
      console.error("Failed to load settings:", err);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  const saveSetting = async (key: string, value: unknown) => {
    setSaving(key);
    try {
      await fetch(`/api/settings/${key}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      });
    } catch (err) {
      console.error("Failed to save setting:", err);
    }
    setSaving(null);
  };

  const toggleRevealSecret = async (key: string) => {
    if (revealedSecrets[key] !== undefined) {
      setRevealedSecrets((prev) => { const next = { ...prev }; delete next[key]; return next; });
      return;
    }
    try {
      const res = await fetch(`/api/secrets/${encodeURIComponent(key)}/reveal`);
      if (res.ok) {
        const data = await res.json();
        setRevealedSecrets((prev) => ({ ...prev, [key]: data.value }));
      }
    } catch (err) { console.error("Failed to reveal secret:", err); }
  };

  const addSecret = async () => {
    if (!newSecretKey.trim() || !newSecretValue.trim()) return;
    try {
      await fetch("/api/secrets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: newSecretKey, value: newSecretValue }),
      });
      setNewSecretKey(""); setNewSecretValue(""); loadAll();
    } catch (err) { console.error("Failed to add secret:", err); }
  };

  const deleteSecret = async (key: string) => {
    try { await fetch(`/api/secrets/${key}`, { method: "DELETE" }); loadAll(); }
    catch (err) { console.error("Failed to delete secret:", err); }
  };

  const addEnvVar = async () => {
    if (!newEnvKey.trim()) return;
    const updated = { vars: [...settings.default_env_vars.vars, { key: newEnvKey.trim(), value: newEnvValue }] };
    setSettings({ ...settings, default_env_vars: updated });
    setNewEnvKey(""); setNewEnvValue("");
    await saveSetting("default_env_vars", updated);
  };

  const deleteEnvVar = async (idx: number) => {
    const updated = { vars: settings.default_env_vars.vars.filter((_, i) => i !== idx) };
    setSettings({ ...settings, default_env_vars: updated });
    await saveSetting("default_env_vars", updated);
  };

  const saveSkill = async () => {
    if (!skillForm.name.trim() || !skillForm.instructions.trim()) return;
    try {
      if (editingSkill) {
        await fetch(`/api/skills/${editingSkill.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(skillForm) });
      } else {
        const resp = await fetch("/api/skills", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(skillForm) });
        const created = await resp.json();
        if (created.id) setSelectedSkillId(created.id);
      }
      setEditingSkill(null); setNewSkill(false);
      setSkillForm({ name: "", description: "", instructions: "", tags: "" });
      loadAll();
    } catch (err) { console.error("Failed to save skill:", err); }
  };

  const deleteSkill = async (id: number) => {
    try {
      await fetch(`/api/skills/${id}`, { method: "DELETE" });
      if (selectedSkillId === id) { setSelectedSkillId(null); setEditingSkill(null); setNewSkill(false); }
      loadAll();
    } catch (err) { console.error("Failed to delete skill:", err); }
  };

  const startEditSkill = (skill: Skill) => {
    setEditingSkill(skill); setNewSkill(false); setSelectedSkillId(skill.id);
    setSkillForm({ name: skill.name, description: skill.description || "", instructions: skill.instructions, tags: skill.tags || "" });
  };

  const startNewSkill = () => {
    setEditingSkill(null); setNewSkill(true); setSelectedSkillId(null);
    setSkillForm({ name: "", description: "", instructions: "", tags: "" });
  };

  const importFromUrl = async () => {
    if (!importUrl.trim()) return;
    setImporting(true); setImportError("");
    try {
      const resp = await fetch("/api/skills/import-url", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: importUrl.trim() }) });
      const data = await resp.json();
      if (!resp.ok) { setImportError(data.error || "Import failed"); return; }
      setSkills((prev) => [...prev, data]);
      setSelectedSkillId(data.id); setImportUrl(""); setImportError("");
    } catch { setImportError("Network error — could not reach server"); }
    finally { setImporting(false); }
  };

  // ── Brands ──────────────────────────────────────────────────────────────────

  const parseUrls = (text: string): string[] =>
    text.split(/[\n,]/).map((u) => u.trim()).filter(Boolean);

  const startNewBrand = () => {
    setNewBrand(true); setSelectedBrandId(null); setBrandError("");
    setBrandForm({ name: "", urlsText: "", profile: "" });
  };

  const selectBrand = (brand: Brand) => {
    setSelectedBrandId(brand.id); setNewBrand(false); setBrandError("");
    setBrandForm({ name: brand.name, urlsText: brand.urls.join("\n"), profile: brand.profile });
  };

  const saveBrand = async (opts: { scrape: boolean }) => {
    if (!brandForm.name.trim()) { setBrandError("Name is required"); return; }
    const urls = parseUrls(brandForm.urlsText);
    if (opts.scrape && urls.length === 0) { setBrandError("Add at least one URL to scrape"); return; }
    setBrandBusy(opts.scrape ? "scraping" : "saving"); setBrandError("");
    try {
      if (newBrand) {
        const resp = await fetch("/api/brands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: brandForm.name.trim(), urls, profile: brandForm.profile, scrape: opts.scrape }),
        });
        const data = await resp.json();
        if (!resp.ok) { setBrandError(data.error || "Failed to save brand"); return; }
        setSelectedBrandId(data.brand.id); setNewBrand(false);
        if (Array.isArray(data.failedUrls) && data.failedUrls.length > 0) {
          const failed = data.failedUrls.map((f: { url: string; error: string }) => `${f.url} (${f.error})`).join(", ");
          setBrandError(`Scraped ${data.fetchedUrls?.length || 0}/${urls.length} URLs. Failed: ${failed}`);
        }
      } else if (selectedBrandId) {
        const resp = await fetch(`/api/brands/${selectedBrandId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: brandForm.name.trim(), urls, profile: brandForm.profile }),
        });
        const data = await resp.json();
        if (!resp.ok) { setBrandError(data.error || "Failed to save brand"); return; }
      }
      await loadAll();
    } catch (err) {
      setBrandError(err instanceof Error ? err.message : "Network error");
    } finally { setBrandBusy(null); }
  };

  const rescrapeBrand = async () => {
    if (!selectedBrandId) return;
    const urls = parseUrls(brandForm.urlsText);
    if (urls.length === 0) { setBrandError("Add at least one URL before re-scraping"); return; }
    if (!confirm("Re-scrape this brand? This overwrites the current profile.")) return;
    setBrandBusy("rescraping"); setBrandError("");
    try {
      const resp = await fetch(`/api/brands/${selectedBrandId}/rescrape`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls }),
      });
      const data = await resp.json();
      if (!resp.ok) { setBrandError(data.error || "Re-scrape failed"); return; }
      setBrandForm({ name: data.brand.name, urlsText: data.brand.urls.join("\n"), profile: data.brand.profile });
      if (Array.isArray(data.failedUrls) && data.failedUrls.length > 0) {
        const failed = data.failedUrls.map((f: { url: string; error: string }) => `${f.url} (${f.error})`).join(", ");
        setBrandError(`Scraped ${data.fetchedUrls?.length || 0}/${urls.length} URLs. Failed: ${failed}`);
      }
      await loadAll();
    } catch (err) {
      setBrandError(err instanceof Error ? err.message : "Network error");
    } finally { setBrandBusy(null); }
  };

  const deleteBrand = async (id: number) => {
    if (!confirm("Delete this brand? Projects using it will lose the association.")) return;
    try {
      await fetch(`/api/brands/${id}`, { method: "DELETE" });
      if (selectedBrandId === id) { setSelectedBrandId(null); setNewBrand(false); }
      await loadAll();
    } catch (err) { console.error("Failed to delete brand:", err); }
  };

  const selectedSkill = skills.find((s) => s.id === selectedSkillId) || null;

  const renderSecretsPanel = () => (
    <div className="stg-panel">
      <div className="stg-panel-header">
        <h3>Global Secrets Vault</h3>
        <p className="stg-panel-hint">Secrets are injected into all project runtimes. Values are never exposed via API.</p>
      </div>
      <div className="stg-panel-body">
        <div className="stg-list">
          {secrets.map((key) => (
            <div className="stg-list-row" key={key}>
              <span className="stg-key">{key}</span>
              <span className="stg-val">{revealedSecrets[key] !== undefined ? revealedSecrets[key] : "••••••••"}</span>
              <button className="stg-btn-sm" onClick={() => toggleRevealSecret(key)}>{revealedSecrets[key] !== undefined ? "Hide" : "Show"}</button>
              <button className="stg-btn-sm danger" onClick={() => deleteSecret(key)}>Delete</button>
            </div>
          ))}
          {secrets.length === 0 && <div className="stg-empty">No secrets configured</div>}
        </div>
        <div className="stg-add-row">
          <input placeholder="KEY" value={newSecretKey} onChange={(e) => setNewSecretKey(e.target.value)} className="stg-input sm" />
          <input placeholder="Value" type="password" value={newSecretValue} onChange={(e) => setNewSecretValue(e.target.value)} className="stg-input sm" />
          <button className="stg-btn" onClick={addSecret}>Add</button>
        </div>
      </div>
    </div>
  );

  const renderEnvVarsPanel = () => (
    <div className="stg-panel">
      <div className="stg-panel-header">
        <h3>Default Environment Variables</h3>
        <p className="stg-panel-hint">Injected into all project runtimes. Project-level vars override these.</p>
      </div>
      <div className="stg-panel-body">
        <div className="stg-list">
          {settings.default_env_vars.vars.map((v, idx) => (
            <div className="stg-list-row" key={idx}>
              <span className="stg-key">{v.key}</span>
              <span className="stg-val">{v.value}</span>
              <button className="stg-btn-sm danger" onClick={() => deleteEnvVar(idx)}>Delete</button>
            </div>
          ))}
          {settings.default_env_vars.vars.length === 0 && <div className="stg-empty">No default env vars configured</div>}
        </div>
        <div className="stg-add-row">
          <input placeholder="KEY" value={newEnvKey} onChange={(e) => setNewEnvKey(e.target.value)} className="stg-input sm" />
          <input placeholder="Value" value={newEnvValue} onChange={(e) => setNewEnvValue(e.target.value)} className="stg-input sm" />
          <button className="stg-btn" onClick={addEnvVar}>Add</button>
        </div>
        {saving === "default_env_vars" && <span className="stg-saving">Saving...</span>}
      </div>
    </div>
  );

  const renderGitHubPanel = () => (
    <div className="stg-panel">
      <div className="stg-panel-header"><h3>GitHub Integration</h3></div>
      <div className="stg-panel-body">
        <div className="stg-field">
          <label>Repository <span className="stg-hint-inline">(owner/repo)</span></label>
          <input type="text" value={settings.github?.repo || ""} onChange={(e) => setSettings({ ...settings, github: { ...settings.github, repo: e.target.value } })} onBlur={() => saveSetting("github", settings.github)} className="stg-input" placeholder="BrianBMorgan/ForgeOS" />
        </div>
        <div className="stg-field">
          <label className="stg-toggle-row">
            <input type="checkbox" checked={settings.github?.autoPush ?? true} onChange={(e) => { const updated = { ...settings.github, autoPush: e.target.checked }; setSettings({ ...settings, github: updated }); saveSetting("github", updated); }} />
            <span>Auto-push to GitHub on Publish</span>
          </label>
          <div className="stg-hint">Make sure <code>GITHUB_TOKEN</code> is set in the Secrets Vault with repo push access.</div>
        </div>
      </div>
    </div>
  );

  const renderSkillsPanel = () => (
    <div className="stg-panel stg-skills-layout">
      <div className="stg-skills-sidebar">
        <div className="stg-skills-sidebar-header">
          <span>Skills</span>
          <button className="stg-btn-sm" onClick={startNewSkill}>+ New</button>
        </div>
        <div className="stg-skills-list">
          {skills.map((skill) => (
            <div key={skill.id} className={`stg-skill-tab${selectedSkillId === skill.id ? " active" : ""}`} onClick={() => { setSelectedSkillId(skill.id); setEditingSkill(null); setNewSkill(false); }}>
              <span className="stg-skill-tab-name">{skill.name}</span>
              {skill.tags && <span className="stg-skill-tab-tags">{skill.tags.split(",").slice(0, 2).join(", ")}</span>}
            </div>
          ))}
          {skills.length === 0 && <div className="stg-empty">No skills yet</div>}
        </div>
        <div className="stg-skills-import">
          <div className="stg-skills-import-label">Import Skill</div>
          <div className="stg-skills-import-row">
            <input value={importUrl} onChange={(e) => { setImportUrl(e.target.value); setImportError(""); }} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") importFromUrl(); }} className="stg-input sm" placeholder="SkillsMP or GitHub URL..." disabled={importing} />
            <button className="stg-btn-sm" onClick={importFromUrl} disabled={importing || !importUrl.trim()}>{importing ? "..." : "Go"}</button>
          </div>
          {importError && <div className="stg-import-error">{importError}</div>}
        </div>
      </div>
      <div className="stg-skills-canvas">
        {newSkill ? (
          <div className="stg-skill-editor">
            <h3>New Skill</h3>
            <div className="stg-field"><label>Name</label><input value={skillForm.name} onChange={(e) => setSkillForm({ ...skillForm, name: e.target.value })} className="stg-input" placeholder="e.g. fal.ai Flux Pro" /></div>
            <div className="stg-field"><label>Description</label><input value={skillForm.description} onChange={(e) => setSkillForm({ ...skillForm, description: e.target.value })} className="stg-input" placeholder="Short description" /></div>
            <div className="stg-field"><label>Tags <span className="stg-hint-inline">(comma-separated)</span></label><input value={skillForm.tags} onChange={(e) => setSkillForm({ ...skillForm, tags: e.target.value })} className="stg-input" placeholder="e.g. images, ai" /></div>
            <div className="stg-field stg-field-grow"><label>Instructions</label><textarea value={skillForm.instructions} onChange={(e) => setSkillForm({ ...skillForm, instructions: e.target.value })} onKeyDown={(e) => e.stopPropagation()} className="stg-textarea stg-textarea-grow" placeholder="Detailed instructions for the agent..." /></div>
            <div className="stg-skill-editor-actions">
              <button className="stg-btn" onClick={saveSkill}>Save</button>
              <button className="stg-btn secondary" onClick={() => setNewSkill(false)}>Cancel</button>
            </div>
          </div>
        ) : editingSkill ? (
          <div className="stg-skill-editor">
            <h3>Edit: {editingSkill.name}</h3>
            <div className="stg-field"><label>Name</label><input value={skillForm.name} onChange={(e) => setSkillForm({ ...skillForm, name: e.target.value })} className="stg-input" /></div>
            <div className="stg-field"><label>Description</label><input value={skillForm.description} onChange={(e) => setSkillForm({ ...skillForm, description: e.target.value })} className="stg-input" /></div>
            <div className="stg-field"><label>Tags</label><input value={skillForm.tags} onChange={(e) => setSkillForm({ ...skillForm, tags: e.target.value })} className="stg-input" /></div>
            <div className="stg-field stg-field-grow"><label>Instructions</label><textarea value={skillForm.instructions} onChange={(e) => setSkillForm({ ...skillForm, instructions: e.target.value })} onKeyDown={(e) => e.stopPropagation()} className="stg-textarea stg-textarea-grow" /></div>
            <div className="stg-skill-editor-actions">
              <button className="stg-btn" onClick={saveSkill}>Save</button>
              <button className="stg-btn secondary" onClick={() => setEditingSkill(null)}>Cancel</button>
            </div>
          </div>
        ) : selectedSkill ? (
          <div className="stg-skill-view">
            <div className="stg-skill-view-header">
              <h3>{selectedSkill.name}</h3>
              <div className="stg-skill-view-actions">
                <button className="stg-btn-sm" onClick={() => startEditSkill(selectedSkill)}>Edit</button>
                <button className="stg-btn-sm danger" onClick={() => deleteSkill(selectedSkill.id)}>Delete</button>
              </div>
            </div>
            {selectedSkill.description && <p className="stg-skill-view-desc">{selectedSkill.description}</p>}
            {selectedSkill.tags && <div className="stg-skill-view-tags">{selectedSkill.tags.split(",").map((t) => <span key={t.trim()} className="stg-tag">{t.trim()}</span>)}</div>}
            <div className="stg-skill-view-instructions"><pre>{selectedSkill.instructions}</pre></div>
          </div>
        ) : (
          <div className="stg-skill-empty"><p>Select a skill or create a new one.</p></div>
        )}
      </div>
    </div>
  );

  const renderBrandsPanel = () => {
    const selectedBrand = brands.find((b) => b.id === selectedBrandId) || null;
    const isEditing = newBrand || selectedBrand !== null;
    const busyLabel = brandBusy === "scraping" ? "Scraping…"
      : brandBusy === "rescraping" ? "Re-scraping…"
      : brandBusy === "saving" ? "Saving…" : null;
    return (
      <div className="stg-panel stg-skills-layout">
        <div className="stg-skills-sidebar">
          <div className="stg-skills-sidebar-header">
            <span>Brands</span>
            <button className="stg-btn-sm" onClick={startNewBrand}>+ New</button>
          </div>
          <div className="stg-skills-list">
            {brands.map((brand) => (
              <div key={brand.id} className={`stg-skill-tab${selectedBrandId === brand.id ? " active" : ""}`} onClick={() => selectBrand(brand)}>
                <span className="stg-skill-tab-name">{brand.name}</span>
                {brand.urls.length > 0 && <span className="stg-skill-tab-tags">{brand.urls.length} URL{brand.urls.length === 1 ? "" : "s"}</span>}
              </div>
            ))}
            {brands.length === 0 && <div className="stg-empty">No brands yet</div>}
          </div>
        </div>
        <div className="stg-skills-canvas">
          {isEditing ? (
            <div className="stg-skill-editor">
              <h3>{newBrand ? "New Brand" : `Edit: ${selectedBrand?.name || ""}`}</h3>
              <div className="stg-field">
                <label>Name</label>
                <input value={brandForm.name} onChange={(e) => setBrandForm({ ...brandForm, name: e.target.value })} className="stg-input" placeholder="e.g. Sandbox-XM" />
              </div>
              <div className="stg-field">
                <label>Source URLs <span className="stg-hint-inline">(one per line or comma-separated, up to 3 used for scraping)</span></label>
                <textarea value={brandForm.urlsText} onChange={(e) => setBrandForm({ ...brandForm, urlsText: e.target.value })} onKeyDown={(e) => e.stopPropagation()} className="stg-textarea" style={{ minHeight: 80 }} placeholder="https://example.com&#10;https://example.com/about&#10;https://example.com/blog/post" />
              </div>
              <div className="stg-field stg-field-grow">
                <label>Profile <span className="stg-hint-inline">(markdown — scrape fills this in; you can hand-edit after)</span></label>
                <textarea value={brandForm.profile} onChange={(e) => setBrandForm({ ...brandForm, profile: e.target.value })} onKeyDown={(e) => e.stopPropagation()} className="stg-textarea stg-textarea-grow" placeholder="# Brand Profile: ..." />
              </div>
              {brandError && <div className="stg-import-error">{brandError}</div>}
              <div className="stg-skill-editor-actions">
                <button className="stg-btn" onClick={() => saveBrand({ scrape: false })} disabled={brandBusy !== null}>Save</button>
                {newBrand ? (
                  <button className="stg-btn" onClick={() => saveBrand({ scrape: true })} disabled={brandBusy !== null}>Save & Scrape</button>
                ) : (
                  <button className="stg-btn" onClick={rescrapeBrand} disabled={brandBusy !== null}>Re-scrape</button>
                )}
                {!newBrand && selectedBrand && (
                  <button className="stg-btn secondary danger" onClick={() => deleteBrand(selectedBrand.id)} disabled={brandBusy !== null}>Delete</button>
                )}
                <button className="stg-btn secondary" onClick={() => { setNewBrand(false); setSelectedBrandId(null); setBrandError(""); }} disabled={brandBusy !== null}>Cancel</button>
                {busyLabel && <span className="stg-saving">{busyLabel}</span>}
              </div>
              {!newBrand && selectedBrand?.lastScrapedAt && (
                <div className="stg-hint">Last scraped {new Date(selectedBrand.lastScrapedAt).toLocaleString()}</div>
              )}
            </div>
          ) : (
            <div className="stg-skill-empty"><p>Select a brand or create a new one. Scraping pulls HTML from the URLs, runs it through Claude, and produces an editable brand profile.</p></div>
          )}
        </div>
      </div>
    );
  };

  const renderActivePanel = () => {
    switch (activeTab) {
      case "secrets": return renderSecretsPanel();
      case "env_vars": return renderEnvVarsPanel();
      case "github": return renderGitHubPanel();
      case "skills": return renderSkillsPanel();
      case "brands": return renderBrandsPanel();
    }
  };

  return (
    <div className="stg-page">
      <div className="stg-sidebar">
        <div className="stg-sidebar-title">Settings</div>
        {TABS.map((tab) => (
          <div key={tab.id} className={`stg-tab${activeTab === tab.id ? " active" : ""}`} onClick={() => setActiveTab(tab.id)}>
            <span className="stg-tab-icon">{tab.icon}</span>
            <span className="stg-tab-label">{tab.label}</span>
          </div>
        ))}
      </div>
      <div className="stg-canvas">{renderActivePanel()}</div>
    </div>
  );
}
