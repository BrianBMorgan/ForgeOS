import { useState, useEffect, useCallback } from "react";

interface SettingValues {
  model_config: { plannerModel: string; reviewerModel: string; plannerTemp: number; reviewerTemp: number };
  auto_approve: { enabled: boolean; maxRiskLevel: string };
  default_env_vars: { vars: { key: string; value: string }[] };
  workspace_limits: { portRangeStart: number; portRangeEnd: number; maxConcurrentApps: number; logRetention: number };
  allowed_tech_stack: { allowed: string[]; banned: string[] };
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

const MODEL_OPTIONS = [
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "gpt-4o",
  "gpt-4o-mini",
  "o3",
  "o3-mini",
  "o4-mini",
];

const DEFAULT_SETTINGS: SettingValues = {
  model_config: { plannerModel: "gpt-4.1", reviewerModel: "gpt-4.1-mini", plannerTemp: 0.7, reviewerTemp: 0.2 },
  auto_approve: { enabled: false, maxRiskLevel: "low" },
  default_env_vars: { vars: [] },
  workspace_limits: { portRangeStart: 4000, portRangeEnd: 4099, maxConcurrentApps: 5, logRetention: 2000 },
  allowed_tech_stack: { allowed: [], banned: [] },
};

type TabId = "secrets" | "models" | "auto_approve" | "env_vars" | "limits" | "tech_stack" | "skills";

const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: "secrets", label: "Secrets Vault", icon: "🔐" },
  { id: "models", label: "Model Config", icon: "🧠" },
  { id: "auto_approve", label: "Auto-Approve", icon: "✅" },
  { id: "env_vars", label: "Default Env Vars", icon: "📋" },
  { id: "limits", label: "Workspace Limits", icon: "📐" },
  { id: "tech_stack", label: "Tech Stack", icon: "📦" },
  { id: "skills", label: "Skills Library", icon: "📚" },
];

export default function Settings() {
  const [settings, setSettings] = useState<SettingValues>(DEFAULT_SETTINGS);
  const [secrets, setSecrets] = useState<string[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
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
  const [allowedText, setAllowedText] = useState("");
  const [bannedText, setBannedText] = useState("");
  const [revealedSecrets, setRevealedSecrets] = useState<Record<string, string>>({});

  const loadAll = useCallback(async () => {
    try {
      const [settingsRes, secretsRes, skillsRes] = await Promise.all([
        fetch("/api/settings"),
        fetch("/api/secrets"),
        fetch("/api/skills"),
      ]);
      const settingsData = await settingsRes.json();
      const secretsData = await secretsRes.json();
      const skillsData = await skillsRes.json();

      const merged = { ...DEFAULT_SETTINGS };
      if (settingsData && typeof settingsData === "object" && !Array.isArray(settingsData)) {
        for (const key of Object.keys(merged)) {
          if (key in settingsData) {
            (merged as Record<string, unknown>)[key] = settingsData[key];
          }
        }
      }
      setSettings(merged);
      setAllowedText((merged.allowed_tech_stack.allowed || []).join(", "));
      setBannedText((merged.allowed_tech_stack.banned || []).join(", "));
      setSecrets(secretsData.secrets || []);
      setSkills(skillsData.skills || []);
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
      setRevealedSecrets((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      return;
    }
    try {
      const res = await fetch(`/api/secrets/${encodeURIComponent(key)}/reveal`);
      if (res.ok) {
        const data = await res.json();
        setRevealedSecrets((prev) => ({ ...prev, [key]: data.value }));
      }
    } catch (err) {
      console.error("Failed to reveal secret:", err);
    }
  };

  const addSecret = async () => {
    if (!newSecretKey.trim() || !newSecretValue.trim()) return;
    try {
      await fetch("/api/secrets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: newSecretKey, value: newSecretValue }),
      });
      setNewSecretKey("");
      setNewSecretValue("");
      loadAll();
    } catch (err) {
      console.error("Failed to add secret:", err);
    }
  };

  const deleteSecret = async (key: string) => {
    try {
      await fetch(`/api/secrets/${key}`, { method: "DELETE" });
      loadAll();
    } catch (err) {
      console.error("Failed to delete secret:", err);
    }
  };

  const addEnvVar = async () => {
    if (!newEnvKey.trim()) return;
    const updated = { vars: [...settings.default_env_vars.vars, { key: newEnvKey.trim(), value: newEnvValue }] };
    setSettings({ ...settings, default_env_vars: updated });
    setNewEnvKey("");
    setNewEnvValue("");
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
        await fetch(`/api/skills/${editingSkill.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(skillForm),
        });
      } else {
        const resp = await fetch("/api/skills", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(skillForm),
        });
        const created = await resp.json();
        if (created.id) setSelectedSkillId(created.id);
      }
      setEditingSkill(null);
      setNewSkill(false);
      setSkillForm({ name: "", description: "", instructions: "", tags: "" });
      loadAll();
    } catch (err) {
      console.error("Failed to save skill:", err);
    }
  };

  const deleteSkill = async (id: number) => {
    try {
      await fetch(`/api/skills/${id}`, { method: "DELETE" });
      if (selectedSkillId === id) {
        setSelectedSkillId(null);
        setEditingSkill(null);
        setNewSkill(false);
      }
      loadAll();
    } catch (err) {
      console.error("Failed to delete skill:", err);
    }
  };

  const startEditSkill = (skill: Skill) => {
    setEditingSkill(skill);
    setNewSkill(false);
    setSelectedSkillId(skill.id);
    setSkillForm({ name: skill.name, description: skill.description || "", instructions: skill.instructions, tags: skill.tags || "" });
  };

  const startNewSkill = () => {
    setEditingSkill(null);
    setNewSkill(true);
    setSelectedSkillId(null);
    setSkillForm({ name: "", description: "", instructions: "", tags: "" });
  };

  const importFromUrl = async () => {
    if (!importUrl.trim()) return;
    setImporting(true);
    setImportError("");
    try {
      const resp = await fetch("/api/skills/import-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: importUrl.trim() }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setImportError(data.error || "Import failed");
        return;
      }
      setSkills((prev) => [...prev, data]);
      setSelectedSkillId(data.id);
      setImportUrl("");
      setImportError("");
    } catch {
      setImportError("Network error — could not reach server");
    } finally {
      setImporting(false);
    }
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

  const renderModelsPanel = () => (
    <div className="stg-panel">
      <div className="stg-panel-header">
        <h3>Model Configuration</h3>
      </div>
      <div className="stg-panel-body">
        <div className="stg-field">
          <label>Planner Model</label>
          <select value={settings.model_config.plannerModel} onChange={(e) => {
            const updated = { ...settings.model_config, plannerModel: e.target.value };
            setSettings({ ...settings, model_config: updated });
            saveSetting("model_config", updated);
          }} className="stg-select">{MODEL_OPTIONS.map((m) => <option key={m} value={m}>{m}</option>)}</select>
        </div>
        <div className="stg-field">
          <label>Reviewer Model</label>
          <select value={settings.model_config.reviewerModel} onChange={(e) => {
            const updated = { ...settings.model_config, reviewerModel: e.target.value };
            setSettings({ ...settings, model_config: updated });
            saveSetting("model_config", updated);
          }} className="stg-select">{MODEL_OPTIONS.map((m) => <option key={m} value={m}>{m}</option>)}</select>
        </div>
        <div className="stg-field">
          <label>Planner Temperature <span className="stg-badge">{settings.model_config.plannerTemp}</span></label>
          <input type="range" min="0" max="2" step="0.1" value={settings.model_config.plannerTemp} onChange={(e) => {
            const updated = { ...settings.model_config, plannerTemp: parseFloat(e.target.value) };
            setSettings({ ...settings, model_config: updated });
          }} onMouseUp={() => saveSetting("model_config", settings.model_config)} className="stg-range" />
        </div>
        <div className="stg-field">
          <label>Reviewer Temperature <span className="stg-badge">{settings.model_config.reviewerTemp}</span></label>
          <input type="range" min="0" max="2" step="0.1" value={settings.model_config.reviewerTemp} onChange={(e) => {
            const updated = { ...settings.model_config, reviewerTemp: parseFloat(e.target.value) };
            setSettings({ ...settings, model_config: updated });
          }} onMouseUp={() => saveSetting("model_config", settings.model_config)} className="stg-range" />
        </div>
        {saving === "model_config" && <span className="stg-saving">Saving...</span>}
      </div>
    </div>
  );

  const renderAutoApprovePanel = () => (
    <div className="stg-panel">
      <div className="stg-panel-header">
        <h3>Auto-Approve Policy</h3>
        <p className="stg-panel-hint">When enabled, the pipeline will skip human approval for builds at or below the selected risk level.</p>
      </div>
      <div className="stg-panel-body">
        <div className="stg-field">
          <label className="stg-toggle-row">
            <input type="checkbox" checked={settings.auto_approve.enabled} onChange={(e) => {
              const updated = { ...settings.auto_approve, enabled: e.target.checked };
              setSettings({ ...settings, auto_approve: updated });
              saveSetting("auto_approve", updated);
            }} />
            <span>Enable Auto-Approve</span>
          </label>
        </div>
        {settings.auto_approve.enabled && (
          <div className="stg-field">
            <label>Max Auto-Approve Risk Level</label>
            <select value={settings.auto_approve.maxRiskLevel} onChange={(e) => {
              const updated = { ...settings.auto_approve, maxRiskLevel: e.target.value };
              setSettings({ ...settings, auto_approve: updated });
              saveSetting("auto_approve", updated);
            }} className="stg-select">
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </div>
        )}
      </div>
    </div>
  );

  const renderEnvVarsPanel = () => (
    <div className="stg-panel">
      <div className="stg-panel-header">
        <h3>Default Environment Variables</h3>
        <p className="stg-panel-hint">Default env vars injected into all project runtimes. Project-level vars override these.</p>
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
      </div>
    </div>
  );

  const renderLimitsPanel = () => (
    <div className="stg-panel">
      <div className="stg-panel-header">
        <h3>Workspace Limits</h3>
      </div>
      <div className="stg-panel-body">
        <div className="stg-field">
          <label>Port Range Start</label>
          <input type="number" value={settings.workspace_limits.portRangeStart} onChange={(e) => {
            const updated = { ...settings.workspace_limits, portRangeStart: parseInt(e.target.value) || 4000 };
            setSettings({ ...settings, workspace_limits: updated });
          }} onBlur={() => saveSetting("workspace_limits", settings.workspace_limits)} className="stg-input" />
        </div>
        <div className="stg-field">
          <label>Port Range End</label>
          <input type="number" value={settings.workspace_limits.portRangeEnd} onChange={(e) => {
            const updated = { ...settings.workspace_limits, portRangeEnd: parseInt(e.target.value) || 4099 };
            setSettings({ ...settings, workspace_limits: updated });
          }} onBlur={() => saveSetting("workspace_limits", settings.workspace_limits)} className="stg-input" />
        </div>
        <div className="stg-field">
          <label>Max Concurrent Apps</label>
          <input type="number" value={settings.workspace_limits.maxConcurrentApps} onChange={(e) => {
            const updated = { ...settings.workspace_limits, maxConcurrentApps: parseInt(e.target.value) || 5 };
            setSettings({ ...settings, workspace_limits: updated });
          }} onBlur={() => saveSetting("workspace_limits", settings.workspace_limits)} className="stg-input" />
        </div>
        <div className="stg-field">
          <label>Log Retention (lines)</label>
          <input type="number" value={settings.workspace_limits.logRetention} onChange={(e) => {
            const updated = { ...settings.workspace_limits, logRetention: parseInt(e.target.value) || 2000 };
            setSettings({ ...settings, workspace_limits: updated });
          }} onBlur={() => saveSetting("workspace_limits", settings.workspace_limits)} className="stg-input" />
        </div>
        {saving === "workspace_limits" && <span className="stg-saving">Saving...</span>}
      </div>
    </div>
  );

  const renderTechStackPanel = () => (
    <div className="stg-panel">
      <div className="stg-panel-header">
        <h3>Allowed Tech Stack</h3>
      </div>
      <div className="stg-panel-body">
        <div className="stg-field">
          <label>Allowed Packages <span className="stg-hint-inline">(comma-separated)</span></label>
          <textarea value={allowedText} onChange={(e) => setAllowedText(e.target.value)} onBlur={() => {
            const updated = {
              allowed: allowedText.split(",").map((s) => s.trim()).filter(Boolean),
              banned: bannedText.split(",").map((s) => s.trim()).filter(Boolean),
            };
            setSettings({ ...settings, allowed_tech_stack: updated });
            saveSetting("allowed_tech_stack", updated);
          }} className="stg-textarea" rows={3} />
        </div>
        <div className="stg-field">
          <label>Banned Packages <span className="stg-hint-inline">(comma-separated)</span></label>
          <textarea value={bannedText} onChange={(e) => setBannedText(e.target.value)} onBlur={() => {
            const updated = {
              allowed: allowedText.split(",").map((s) => s.trim()).filter(Boolean),
              banned: bannedText.split(",").map((s) => s.trim()).filter(Boolean),
            };
            setSettings({ ...settings, allowed_tech_stack: updated });
            saveSetting("allowed_tech_stack", updated);
          }} className="stg-textarea" rows={3} />
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
            <div
              key={skill.id}
              className={`stg-skill-tab${selectedSkillId === skill.id ? " active" : ""}`}
              onClick={() => { setSelectedSkillId(skill.id); setEditingSkill(null); setNewSkill(false); }}
            >
              <span className="stg-skill-tab-name">{skill.name}</span>
              {skill.tags && <span className="stg-skill-tab-tags">{skill.tags.split(",").slice(0, 2).join(", ")}</span>}
            </div>
          ))}
          {skills.length === 0 && <div className="stg-empty">No skills yet</div>}
        </div>
        <div className="stg-skills-import">
          <div className="stg-skills-import-label">Import from SkillsMP</div>
          <div className="stg-skills-import-row">
            <input
              value={importUrl}
              onChange={(e) => { setImportUrl(e.target.value); setImportError(""); }}
              onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") importFromUrl(); }}
              className="stg-input sm"
              placeholder="Paste URL..."
              disabled={importing}
            />
            <button className="stg-btn-sm" onClick={importFromUrl} disabled={importing || !importUrl.trim()}>
              {importing ? "..." : "Go"}
            </button>
          </div>
          {importError && <div className="stg-import-error">{importError}</div>}
        </div>
      </div>
      <div className="stg-skills-canvas">
        {newSkill ? (
          <div className="stg-skill-editor">
            <h3>New Skill</h3>
            <div className="stg-field"><label>Name</label><input value={skillForm.name} onChange={(e) => setSkillForm({ ...skillForm, name: e.target.value })} className="stg-input" placeholder="e.g. hCaptcha Integration" /></div>
            <div className="stg-field"><label>Description</label><input value={skillForm.description} onChange={(e) => setSkillForm({ ...skillForm, description: e.target.value })} className="stg-input" placeholder="Short description" /></div>
            <div className="stg-field"><label>Tags <span className="stg-hint-inline">(comma-separated)</span></label><input value={skillForm.tags} onChange={(e) => setSkillForm({ ...skillForm, tags: e.target.value })} className="stg-input" placeholder="e.g. captcha, security" /></div>
            <div className="stg-field stg-field-grow"><label>Instructions</label><textarea value={skillForm.instructions} onChange={(e) => setSkillForm({ ...skillForm, instructions: e.target.value })} onKeyDown={(e) => e.stopPropagation()} className="stg-textarea stg-textarea-grow" placeholder="Detailed instructions for the agent..." /></div>
            <div className="stg-skill-editor-actions">
              <button className="stg-btn" onClick={saveSkill}>Save</button>
              <button className="stg-btn secondary" onClick={() => { setNewSkill(false); }}>Cancel</button>
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
              <button className="stg-btn secondary" onClick={() => { setEditingSkill(null); }}>Cancel</button>
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
            <div className="stg-skill-view-instructions">
              <pre>{selectedSkill.instructions}</pre>
            </div>
          </div>
        ) : (
          <div className="stg-skill-empty">
            <p>Select a skill from the list or create a new one.</p>
          </div>
        )}
      </div>
    </div>
  );

  const renderActivePanel = () => {
    switch (activeTab) {
      case "secrets": return renderSecretsPanel();
      case "models": return renderModelsPanel();
      case "auto_approve": return renderAutoApprovePanel();
      case "env_vars": return renderEnvVarsPanel();
      case "limits": return renderLimitsPanel();
      case "tech_stack": return renderTechStackPanel();
      case "skills": return renderSkillsPanel();
    }
  };

  return (
    <div className="stg-page">
      <div className="stg-sidebar">
        <div className="stg-sidebar-title">Settings</div>
        {TABS.map((tab) => (
          <div
            key={tab.id}
            className={`stg-tab${activeTab === tab.id ? " active" : ""}`}
            onClick={() => setActiveTab(tab.id)}
          >
            <span className="stg-tab-icon">{tab.icon}</span>
            <span className="stg-tab-label">{tab.label}</span>
          </div>
        ))}
      </div>
      <div className="stg-canvas">
        {renderActivePanel()}
      </div>
    </div>
  );
}
