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

export default function Settings() {
  const [settings, setSettings] = useState<SettingValues>(DEFAULT_SETTINGS);
  const [secrets, setSecrets] = useState<string[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [expanded, setExpanded] = useState<string | null>("secrets");
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

  const toggle = (section: string) => {
    setExpanded(expanded === section ? null : section);
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
        await fetch("/api/skills", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(skillForm),
        });
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
      loadAll();
    } catch (err) {
      console.error("Failed to delete skill:", err);
    }
  };

  const startEditSkill = (skill: Skill) => {
    setEditingSkill(skill);
    setNewSkill(false);
    setSkillForm({ name: skill.name, description: skill.description || "", instructions: skill.instructions, tags: skill.tags || "" });
    setExpanded("skills");
  };

  const startNewSkill = () => {
    setEditingSkill(null);
    setNewSkill(true);
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
      setImportUrl("");
      setImportError("");
    } catch {
      setImportError("Network error — could not reach server");
    } finally {
      setImporting(false);
    }
  };

  const renderSection = (id: string, title: string, icon: string, content: React.ReactNode) => (
    <div className="settings-section" key={id}>
      <div className="settings-section-header" onClick={() => toggle(id)}>
        <span className="settings-section-icon">{icon}</span>
        <span className="settings-section-title">{title}</span>
        <span className="settings-section-chevron">{expanded === id ? "▾" : "▸"}</span>
      </div>
      {expanded === id && <div className="settings-section-body">{content}</div>}
    </div>
  );

  return (
    <div className="settings-page">
      <div className="settings-page-header">
        <h2>Settings</h2>
        <p className="settings-page-desc">Global configuration for ForgeOS pipeline, secrets, and workspace defaults.</p>
      </div>

      <div className="settings-sections">
        {renderSection("secrets", "Global Secrets Vault", "🔐", (
          <div>
            <p className="settings-hint">Secrets are injected into all project runtimes. Values are never exposed via API.</p>
            <div className="settings-list">
              {secrets.map((key) => (
                <div className="settings-list-row" key={key}>
                  <span className="settings-env-key">{key}</span>
                  <span className="settings-env-val">{revealedSecrets[key] !== undefined ? revealedSecrets[key] : "••••••••"}</span>
                  <button className="settings-btn-sm" onClick={() => toggleRevealSecret(key)}>{revealedSecrets[key] !== undefined ? "Hide" : "Show"}</button>
                  <button className="settings-btn-sm danger" onClick={() => deleteSecret(key)}>Delete</button>
                </div>
              ))}
            </div>
            <div className="settings-add-row">
              <input placeholder="KEY" value={newSecretKey} onChange={(e) => setNewSecretKey(e.target.value)} className="settings-input sm" />
              <input placeholder="Value" type="password" value={newSecretValue} onChange={(e) => setNewSecretValue(e.target.value)} className="settings-input sm" />
              <button className="settings-btn-sm" onClick={addSecret}>Add</button>
            </div>
          </div>
        ))}

        {renderSection("model_config", "Model Configuration", "🧠", (
          <div>
            <div className="settings-field-group">
              <label>Planner Model</label>
              <select value={settings.model_config.plannerModel} onChange={(e) => {
                const updated = { ...settings.model_config, plannerModel: e.target.value };
                setSettings({ ...settings, model_config: updated });
                saveSetting("model_config", updated);
              }} className="settings-select">
                {MODEL_OPTIONS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div className="settings-field-group">
              <label>Reviewer Model</label>
              <select value={settings.model_config.reviewerModel} onChange={(e) => {
                const updated = { ...settings.model_config, reviewerModel: e.target.value };
                setSettings({ ...settings, model_config: updated });
                saveSetting("model_config", updated);
              }} className="settings-select">
                {MODEL_OPTIONS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div className="settings-field-group">
              <label>Planner Temperature <span className="settings-val-badge">{settings.model_config.plannerTemp}</span></label>
              <input type="range" min="0" max="2" step="0.1" value={settings.model_config.plannerTemp} onChange={(e) => {
                const updated = { ...settings.model_config, plannerTemp: parseFloat(e.target.value) };
                setSettings({ ...settings, model_config: updated });
              }} onMouseUp={() => saveSetting("model_config", settings.model_config)} className="settings-range" />
            </div>
            <div className="settings-field-group">
              <label>Reviewer Temperature <span className="settings-val-badge">{settings.model_config.reviewerTemp}</span></label>
              <input type="range" min="0" max="2" step="0.1" value={settings.model_config.reviewerTemp} onChange={(e) => {
                const updated = { ...settings.model_config, reviewerTemp: parseFloat(e.target.value) };
                setSettings({ ...settings, model_config: updated });
              }} onMouseUp={() => saveSetting("model_config", settings.model_config)} className="settings-range" />
            </div>
            {saving === "model_config" && <span className="settings-saving">Saving...</span>}
          </div>
        ))}

        {renderSection("auto_approve", "Auto-Approve Policy", "✅", (
          <div>
            <p className="settings-hint">When enabled, the pipeline will skip human approval for builds at or below the selected risk level.</p>
            <div className="settings-field-group">
              <label className="settings-toggle-row">
                <input type="checkbox" checked={settings.auto_approve.enabled} onChange={(e) => {
                  const updated = { ...settings.auto_approve, enabled: e.target.checked };
                  setSettings({ ...settings, auto_approve: updated });
                  saveSetting("auto_approve", updated);
                }} />
                <span>Enable Auto-Approve</span>
              </label>
            </div>
            {settings.auto_approve.enabled && (
              <div className="settings-field-group">
                <label>Max Auto-Approve Risk Level</label>
                <select value={settings.auto_approve.maxRiskLevel} onChange={(e) => {
                  const updated = { ...settings.auto_approve, maxRiskLevel: e.target.value };
                  setSettings({ ...settings, auto_approve: updated });
                  saveSetting("auto_approve", updated);
                }} className="settings-select">
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </div>
            )}
          </div>
        ))}

        {renderSection("default_env_vars", "Default Environment Variables", "📋", (
          <div>
            <p className="settings-hint">Default env vars injected into all project runtimes. Project-level vars override these.</p>
            <div className="settings-list">
              {settings.default_env_vars.vars.map((v, idx) => (
                <div className="settings-list-row" key={idx}>
                  <span className="settings-env-key">{v.key}</span>
                  <span className="settings-env-val">{v.value}</span>
                  <button className="settings-btn-sm danger" onClick={() => deleteEnvVar(idx)}>Delete</button>
                </div>
              ))}
            </div>
            <div className="settings-add-row">
              <input placeholder="KEY" value={newEnvKey} onChange={(e) => setNewEnvKey(e.target.value)} className="settings-input sm" />
              <input placeholder="Value" value={newEnvValue} onChange={(e) => setNewEnvValue(e.target.value)} className="settings-input sm" />
              <button className="settings-btn-sm" onClick={addEnvVar}>Add</button>
            </div>
          </div>
        ))}

        {renderSection("workspace_limits", "Workspace Limits", "📐", (
          <div>
            <div className="settings-field-group">
              <label>Port Range Start</label>
              <input type="number" value={settings.workspace_limits.portRangeStart} onChange={(e) => {
                const updated = { ...settings.workspace_limits, portRangeStart: parseInt(e.target.value) || 4000 };
                setSettings({ ...settings, workspace_limits: updated });
              }} onBlur={() => saveSetting("workspace_limits", settings.workspace_limits)} className="settings-input" />
            </div>
            <div className="settings-field-group">
              <label>Port Range End</label>
              <input type="number" value={settings.workspace_limits.portRangeEnd} onChange={(e) => {
                const updated = { ...settings.workspace_limits, portRangeEnd: parseInt(e.target.value) || 4099 };
                setSettings({ ...settings, workspace_limits: updated });
              }} onBlur={() => saveSetting("workspace_limits", settings.workspace_limits)} className="settings-input" />
            </div>
            <div className="settings-field-group">
              <label>Max Concurrent Apps</label>
              <input type="number" value={settings.workspace_limits.maxConcurrentApps} onChange={(e) => {
                const updated = { ...settings.workspace_limits, maxConcurrentApps: parseInt(e.target.value) || 5 };
                setSettings({ ...settings, workspace_limits: updated });
              }} onBlur={() => saveSetting("workspace_limits", settings.workspace_limits)} className="settings-input" />
            </div>
            <div className="settings-field-group">
              <label>Log Retention (lines)</label>
              <input type="number" value={settings.workspace_limits.logRetention} onChange={(e) => {
                const updated = { ...settings.workspace_limits, logRetention: parseInt(e.target.value) || 2000 };
                setSettings({ ...settings, workspace_limits: updated });
              }} onBlur={() => saveSetting("workspace_limits", settings.workspace_limits)} className="settings-input" />
            </div>
            {saving === "workspace_limits" && <span className="settings-saving">Saving...</span>}
          </div>
        ))}

        {renderSection("tech_stack", "Allowed Tech Stack", "📦", (
          <div>
            <div className="settings-field-group">
              <label>Allowed Packages <span className="settings-hint-inline">(comma-separated)</span></label>
              <textarea value={allowedText} onChange={(e) => setAllowedText(e.target.value)} onBlur={() => {
                const updated = {
                  allowed: allowedText.split(",").map((s) => s.trim()).filter(Boolean),
                  banned: bannedText.split(",").map((s) => s.trim()).filter(Boolean),
                };
                setSettings({ ...settings, allowed_tech_stack: updated });
                saveSetting("allowed_tech_stack", updated);
              }} className="settings-textarea" rows={3} />
            </div>
            <div className="settings-field-group">
              <label>Banned Packages <span className="settings-hint-inline">(comma-separated)</span></label>
              <textarea value={bannedText} onChange={(e) => setBannedText(e.target.value)} onBlur={() => {
                const updated = {
                  allowed: allowedText.split(",").map((s) => s.trim()).filter(Boolean),
                  banned: bannedText.split(",").map((s) => s.trim()).filter(Boolean),
                };
                setSettings({ ...settings, allowed_tech_stack: updated });
                saveSetting("allowed_tech_stack", updated);
              }} className="settings-textarea" rows={3} />
            </div>
          </div>
        ))}

        {renderSection("skills", "Skills Library", "📚", (
          <div>
            <p className="settings-hint">Skills are injected into Planner and Executor prompts as reusable knowledge.</p>
            <div className="settings-skills-list">
              {skills.map((skill) => (
                <div className="settings-skill-card" key={skill.id}>
                  <div className="settings-skill-header">
                    <span className="settings-skill-name">{skill.name}</span>
                    {skill.tags && <span className="settings-skill-tags">{skill.tags}</span>}
                    <div className="settings-skill-actions">
                      <button className="settings-btn-sm" onClick={() => startEditSkill(skill)}>Edit</button>
                      <button className="settings-btn-sm danger" onClick={() => deleteSkill(skill.id)}>Delete</button>
                    </div>
                  </div>
                  {skill.description && <p className="settings-skill-desc">{skill.description}</p>}
                </div>
              ))}
            </div>

            <div className="settings-import-section">
              <h4>Import from SkillsMP</h4>
              <p className="settings-hint">Paste a SkillsMP URL to import the skill directly into your library.</p>
              <div className="settings-import-row">
                <input
                  value={importUrl}
                  onChange={(e) => { setImportUrl(e.target.value); setImportError(""); }}
                  onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") importFromUrl(); }}
                  className="settings-input"
                  placeholder="https://skillsmp.com/skills/..."
                  disabled={importing}
                />
                <button className="settings-btn" onClick={importFromUrl} disabled={importing || !importUrl.trim()}>
                  {importing ? "Importing..." : "Import"}
                </button>
              </div>
              {importError && <p className="settings-import-error">{importError}</p>}
            </div>

            {(newSkill || editingSkill) ? (
              <div className="settings-skill-form">
                <h4>{editingSkill ? "Edit Skill" : "New Skill"}</h4>
                <div className="settings-field-group">
                  <label>Name</label>
                  <input value={skillForm.name} onChange={(e) => setSkillForm({ ...skillForm, name: e.target.value })} className="settings-input" placeholder="e.g. hCaptcha Integration" />
                </div>
                <div className="settings-field-group">
                  <label>Description</label>
                  <input value={skillForm.description} onChange={(e) => setSkillForm({ ...skillForm, description: e.target.value })} className="settings-input" placeholder="Short description" />
                </div>
                <div className="settings-field-group">
                  <label>Tags <span className="settings-hint-inline">(comma-separated)</span></label>
                  <input value={skillForm.tags} onChange={(e) => setSkillForm({ ...skillForm, tags: e.target.value })} className="settings-input" placeholder="e.g. captcha, security" />
                </div>
                <div className="settings-field-group">
                  <label>Instructions</label>
                  <textarea value={skillForm.instructions} onChange={(e) => setSkillForm({ ...skillForm, instructions: e.target.value })} onKeyDown={(e) => e.stopPropagation()} className="settings-textarea" rows={8} placeholder="Detailed instructions for the agent..." />
                </div>
                <div className="settings-skill-form-actions">
                  <button className="settings-btn" onClick={saveSkill}>Save</button>
                  <button className="settings-btn secondary" onClick={() => { setNewSkill(false); setEditingSkill(null); }}>Cancel</button>
                </div>
              </div>
            ) : (
              <button className="settings-btn" onClick={startNewSkill}>+ Add Skill</button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}