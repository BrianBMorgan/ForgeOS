import { useState, useRef, useEffect, useCallback } from "react";
import type { ProjectData, ChatMessage } from "../App";
import "./PromptColumn.css";

interface PromptColumnProps {
  projectData: ProjectData | null;
  isNewProject: boolean;
  chatMessages: ChatMessage[];
  onSendChat: (message: string, attachments?: {name: string; dataUrl: string; mimeType: string}[]) => void;
  chatLoading: boolean;
}


interface SkillOption {
  id: number;
  name: string;
  slug: string;
  description: string;
}

interface AssetOption {
  filename: string;
  mimetype: string;
}

/**
 * Strip markdown formatting to produce clean plain text for chat display.
 * Handles: headers, bold, italic, code blocks, inline code, links, lists, etc.
 */

export default function PromptColumn({
  projectData,
  isNewProject,
  chatMessages,
  onSendChat,
  chatLoading,
}: PromptColumnProps) {
  const [prompt, setPrompt] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatThreadRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [skillOptions, setSkillOptions] = useState<SkillOption[]>([]);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [attachments, setAttachments] = useState<{name: string; dataUrl: string; mimeType: string}[]>([]);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [assets, setAssets] = useState<{filename: string; url: string; mimetype: string}[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [slashPos, setSlashPos] = useState(-1);
  const [assetOptions, setAssetOptions] = useState<AssetOption[]>([]);
  const [assetQuery, setAssetQuery] = useState<string | null>(null);
  const [assetPos, setAssetPos] = useState(-1);

  useEffect(() => {
    (window as unknown as Record<string, unknown>).__forgeSetPrompt = (text: string) => {
      setPrompt((prev) => (prev ? prev + "\n" + text : text));
      if (textareaRef.current) {
        textareaRef.current.focus();
      }
    };
    return () => {
      delete (window as unknown as Record<string, unknown>).__forgeSetPrompt;
    };
  }, []);

  const isRunning = false; // v2: no local workspace, no running state

  function renderInline(text: string): React.ReactNode {
    const parts: React.ReactNode[] = [];
    const regex = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      if (m.index > last) parts.push(text.slice(last, m.index));
      if (m[2]) parts.push(<strong key={m.index}>{m[2]}</strong>);
      else if (m[3]) parts.push(<em key={m.index}>{m[3]}</em>);
      else if (m[4]) parts.push(<code key={m.index} className="md-inline-code">{m[4]}</code>);
      last = m.index + m[0].length;
    }
    if (last < text.length) parts.push(text.slice(last));
    return <>{parts}</>;
  }

  function renderMarkdown(text: string): React.ReactNode {
    if (!text) return null;
    const lines = text.split("\n");
    const elements: React.ReactNode[] = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (line.startsWith("### ")) {
        elements.push(<div key={i} className="md-h3">{line.slice(4)}</div>);
      } else if (line.startsWith("## ")) {
        elements.push(<div key={i} className="md-h2">{line.slice(3)}</div>);
      } else if (line.startsWith("# ")) {
        elements.push(<div key={i} className="md-h1">{line.slice(2)}</div>);
      } else if (line.startsWith("- ") || line.startsWith("* ")) {
        elements.push(<div key={i} className="md-li">• {renderInline(line.slice(2))}</div>);
      } else if (/^\d+\. /.test(line)) {
        elements.push(<div key={i} className="md-li">{renderInline(line)}</div>);
      } else if (line.startsWith("```")) {
        const codeLines: string[] = [];
        i++;
        while (i < lines.length && !lines[i].startsWith("```")) {
          codeLines.push(lines[i]);
          i++;
        }
        elements.push(<pre key={i} className="md-code">{codeLines.join("\n")}</pre>);
      } else if (line.trim() === "") {
        elements.push(<div key={i} className="md-br" />);
      } else {
        elements.push(<div key={i} className="md-p">{renderInline(line)}</div>);
      }
      i++;
    }
    return <>{elements}</>;
  }

  const isProjectView = !isNewProject && projectData;
  const hasChatHistory = chatMessages.length > 0;

  // Smooth scroll to bottom when new messages arrive
  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [chatMessages]);

  useEffect(() => {
    fetch("/api/skills").then(r => r.json()).then(data => {
      const skills = (data.skills || []).map((s: { id: number; name: string; description: string }) => ({
        id: s.id,
        name: s.name,
        slug: s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""),
        description: s.description || "",
      }));
      setSkillOptions(skills);
    }).catch(() => {});
    fetch("/api/assets").then(r => r.json()).then(data => {
      const assets = (Array.isArray(data) ? data : []).map((a: { filename: string; mimetype: string }) => ({
        filename: a.filename,
        mimetype: a.mimetype,
      }));
      setAssetOptions(assets);
    }).catch(() => {});
  }, []);

  const filteredSkills = slashQuery !== null
    ? skillOptions.filter(s =>
        s.slug.includes(slashQuery.toLowerCase()) || s.name.toLowerCase().includes(slashQuery.toLowerCase())
      ).slice(0, 8)
    : [];

  const filteredAssets = assetQuery !== null
    ? assetOptions.filter(a => a.filename.toLowerCase().includes(assetQuery.toLowerCase())).slice(0, 8)
    : [];

  const handlePromptChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setPrompt(val);

    const cursorPos = e.target.selectionStart;
    const textBeforeCursor = val.slice(0, cursorPos);

    // Asset mode: /assets or /assets/partial
    const assetMatch = textBeforeCursor.match(/\/assets(?:\/([^\s]*))?$/i);
    if (assetMatch) {
      setAssetQuery(assetMatch[1] ?? "");
      setAssetPos(cursorPos - assetMatch[0].length);
      setSlashIndex(0);
      setSlashQuery(null);
      setSlashPos(-1);
    } else {
      setAssetQuery(null);
      setAssetPos(-1);
      // Skill mode: /slug
      const slashMatch = textBeforeCursor.match(/\/([a-z0-9-]*)$/i);
      if (slashMatch) {
        setSlashQuery(slashMatch[1]);
        setSlashPos(cursorPos - slashMatch[0].length);
        setSlashIndex(0);
      } else {
        setSlashQuery(null);
        setSlashPos(-1);
      }
    }
  };

  const insertSkill = (skill: SkillOption) => {
    if (slashPos < 0) return;
    const cursorPos = textareaRef.current?.selectionStart || prompt.length;
    const before = prompt.slice(0, slashPos);
    const after = prompt.slice(cursorPos);
    const inserted = `/${skill.slug} `;
    const newPrompt = before + inserted + after;
    setPrompt(newPrompt);
    setSlashQuery(null);
    setSlashPos(-1);
    setTimeout(() => {
      if (textareaRef.current) {
        const pos = before.length + inserted.length;
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(pos, pos);
      }
    }, 0);
  };

  const insertAsset = (asset: AssetOption) => {
    if (assetPos < 0) return;
    const cursorPos = textareaRef.current?.selectionStart || prompt.length;
    const before = prompt.slice(0, assetPos);
    const after = prompt.slice(cursorPos);
    const inserted = `/api/assets/${encodeURIComponent(asset.filename)} `;
    const newPrompt = before + inserted + after;
    setPrompt(newPrompt);
    setAssetQuery(null);
    setAssetPos(-1);
    setTimeout(() => {
      if (textareaRef.current) {
        const pos = before.length + inserted.length;
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(pos, pos);
      }
    }, 0);
  };

  const handleSubmit = () => {
    if ((!prompt.trim() && attachments.length === 0) || chatLoading) return;
    onSendChat(prompt, attachments);
    setPrompt("");
    setAttachments([]);
    setSlashQuery(null);
    setSlashPos(-1);
    setAssetQuery(null);
    setAssetPos(-1);
  };

  const loadAssets = useCallback(async () => {
    try {
      const res = await fetch("/api/assets");
      if (res.ok) {
        const data = await res.json();
        setAssets(data.assets || []);
      }
    } catch {}
  }, []);

  const handleFileAttach = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    files.forEach(file => {
      if (!file.type.startsWith("image/")) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const dataUrl = ev.target?.result as string;
        setAttachments(prev => [...prev, { name: file.name, dataUrl, mimeType: file.type }]);
      };
      reader.readAsDataURL(file);
    });
    e.target.value = "";
    setShowAttachMenu(false);
  };

  const handleAssetAttach = (asset: {filename: string; url: string; mimetype: string}) => {
    // For assets, store the URL as a reference in the message text instead
    setPrompt(prev => prev + (prev ? " " : "") + "/assets/" + asset.filename);
    setShowAttachMenu(false);
  };

  const removeAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };



  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (assetQuery !== null && filteredAssets.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex((prev) => Math.min(prev + 1, filteredAssets.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        insertAsset(filteredAssets[slashIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setAssetQuery(null);
        setAssetPos(-1);
        return;
      }
    }
    if (slashQuery !== null && filteredSkills.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex((prev) => Math.min(prev + 1, filteredSkills.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        insertSkill(filteredSkills[slashIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashQuery(null);
        setSlashPos(-1);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="prompt-column">






      {isProjectView && hasChatHistory && (
        <div className="chat-thread" ref={chatThreadRef}>
          {chatMessages.map((msg) => (
            <div key={msg.id} className={`chat-message chat-${msg.role}${msg.pending ? " chat-live" : ""}`}>
              <div className="chat-role">
                {msg.role === "user" ? "You" : msg.pending ? "Forge is working…" : "Forge"}
              </div>
              <div className={`chat-content${msg.pending ? " chat-live-content" : ""}`}>
                {msg.pending
                  ? (msg.content || "Working…")
                  : msg.role === "assistant"
                    ? renderMarkdown(msg.content)
                    : msg.content}
              </div>
              {msg.toolStatus && (
                <div className="chat-tool-status">⚙ {msg.toolStatus}</div>
              )}
            </div>
          ))}
          <div ref={chatEndRef} />
        </div>
      )}

      {!(isProjectView && hasChatHistory) && <div className="prompt-column-spacer" />}

      {(
        <div className="prompt-input-area">
          <div className="prompt-textarea-wrap">
            <div className="attach-wrap attach-wrap-inline">
              <button
                className="attach-btn"
                onClick={() => { setShowAttachMenu(prev => !prev); if (!showAttachMenu) loadAssets(); }}
                disabled={chatLoading}
                title="Attach file or asset"
              >+</button>
              {showAttachMenu && (
                <div className="attach-menu">
                  <div className="attach-menu-item" onClick={() => fileInputRef.current?.click()}>
                    <span className="attach-menu-icon">🖼</span>
                    <span>Upload image</span>
                  </div>
                  {assets.length > 0 && (
                    <div className="attach-menu-section">
                      <div className="attach-menu-label">Global Assets</div>
                      {assets.slice(0, 8).map(asset => (
                        <div key={asset.filename} className="attach-menu-item" onClick={() => handleAssetAttach(asset)}>
                          <span className="attach-menu-icon">📎</span>
                          <span className="attach-menu-asset-name">{asset.filename}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                style={{ display: "none" }}
                onChange={handleFileAttach}
              />
            </div>
            {assetQuery !== null && filteredAssets.length > 0 && (
              <div className="slash-dropdown">
                {filteredAssets.map((asset, i) => (
                  <div
                    key={asset.filename}
                    className={`slash-option${i === slashIndex ? " active" : ""}`}
                    onMouseDown={(e) => { e.preventDefault(); insertAsset(asset); }}
                    onMouseEnter={() => setSlashIndex(i)}
                  >
                    <span className="slash-option-name">/assets/{asset.filename}</span>
                    <span className="slash-option-desc">{asset.mimetype}</span>
                  </div>
                ))}
              </div>
            )}
            {slashQuery !== null && filteredSkills.length > 0 && (
              <div className="slash-dropdown">
                {filteredSkills.map((skill, i) => (
                  <div
                    key={skill.id}
                    className={`slash-option${i === slashIndex ? " active" : ""}`}
                    onMouseDown={(e) => { e.preventDefault(); insertSkill(skill); }}
                    onMouseEnter={() => setSlashIndex(i)}
                  >
                    <span className="slash-option-name">/{skill.slug}</span>
                    {skill.description && <span className="slash-option-desc">{skill.description}</span>}
                  </div>
                ))}
              </div>
            )}
            <textarea
              ref={textareaRef}
              className="prompt-textarea prompt-textarea-with-attach"
              placeholder="Message Forge — ask, build, fix, or type / for skills..."
              value={prompt}
              onChange={handlePromptChange}
              onKeyDown={handleKeyDown}
              rows={isProjectView ? 3 : 6}
              disabled={chatLoading}
            />
          </div>
          {attachments.length > 0 && (
            <div className="attach-chips">
              {attachments.map((att, i) => (
                <div key={i} className="attach-chip">
                  <span className="attach-chip-name">{att.name}</span>
                  <button className="attach-chip-remove" onClick={() => removeAttachment(i)}>✕</button>
                </div>
              ))}
            </div>
          )}
          <div className="prompt-actions">
          </div>
        </div>
      )}

      {/* Pipeline visualization removed — agent chat is the pipeline */}




    </div>
  );
}

