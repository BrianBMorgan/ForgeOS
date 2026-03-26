import { useState, useEffect } from 'react';
import { BrandBrief } from '../types';
import { sampleBriefJSON } from '../sampleBrief';
import { Card } from './Card';
import './BrandBriefTab.css';

interface BrandBriefTabProps {
  briefJson: string;
  onBriefChange: (json: string) => void;
  onGenerate: () => void;
  parsedBrief: BrandBrief | null;
}

export function BrandBriefTab({ briefJson, onBriefChange, onGenerate, parsedBrief }: BrandBriefTabProps) {
  const [error, setError] = useState<string | null>(null);
  const [isValid, setIsValid] = useState(false);

  useEffect(() => {
    try {
      if (briefJson.trim()) {
        JSON.parse(briefJson);
        setError(null);
        setIsValid(true);
      } else {
        setError(null);
        setIsValid(false);
      }
    } catch (e) {
      setError((e as Error).message);
      setIsValid(false);
    }
  }, [briefJson]);

  const handleLoadSample = () => {
    onBriefChange(sampleBriefJSON);
  };

  const handleClear = () => {
    onBriefChange('');
  };

  return (
    <div className="brand-brief-tab">
      <div className="tab-header">
        <h1>Brand Brief</h1>
        <p>Paste your brand brief JSON to generate a complete brand system. The more detailed your brief, the more precise the outputs.</p>
      </div>

      <div className="brief-input-section">
        <div className="input-header">
          <label htmlFor="brief-input">Brand Brief JSON</label>
          <div className="input-actions">
            <button className="btn btn-ghost" onClick={handleLoadSample}>
              Load Sample
            </button>
            <button className="btn btn-ghost" onClick={handleClear}>
              Clear
            </button>
          </div>
        </div>
        
        <textarea
          id="brief-input"
          className={`brief-textarea ${error ? 'has-error' : ''}`}
          value={briefJson}
          onChange={(e) => onBriefChange(e.target.value)}
          placeholder='{\n  "company": {\n    "name": "Your Company",\n    ...\n  }\n}'
          spellCheck={false}
        />
        
        {error && (
          <div className="error-message">
            <span className="error-icon">⚠️</span>
            <span>Invalid JSON: {error}</span>
          </div>
        )}

        <div className="generate-section">
          <button 
            className="btn btn-primary btn-generate"
            onClick={onGenerate}
            disabled={!isValid}
          >
            Generate Brand System
          </button>
          {!isValid && briefJson.trim() && !error && (
            <p className="generate-hint">Enter valid JSON to generate</p>
          )}
        </div>
      </div>

      {!briefJson.trim() && (
        <div className="empty-state-panel">
          <div className="empty-state-icon">📋</div>
          <h3>No Brand Brief Loaded</h3>
          <p>Paste your brand brief JSON above, or load our sample brief to explore how Forge Canvas generates a complete brand system.</p>
          <button className="btn btn-primary" onClick={handleLoadSample}>
            Load Sample Brief
          </button>
        </div>
      )}

      {briefJson.trim() && isValid && !parsedBrief && (
        <div className="empty-state-panel">
          <div className="empty-state-icon">✨</div>
          <h3>Brief Ready</h3>
          <p>Your brand brief JSON is valid and ready to go. Click the button below to generate your complete brand system.</p>
          <button className="btn btn-primary" onClick={onGenerate}>
            Generate Brand System
          </button>
        </div>
      )}

      {briefJson.trim() && !isValid && !error && (
        <div className="empty-state-panel">
          <div className="empty-state-icon">⏳</div>
          <h3>Validating...</h3>
          <p>Checking your JSON structure.</p>
        </div>
      )}

      {parsedBrief && (
        <div className="brief-preview">
          <h2>Brief Summary</h2>
          <div className="preview-grid">
            <Card title="Company" subtitle={parsedBrief.company.name}>
              <p><strong>Tagline:</strong> {parsedBrief.company.tagline}</p>
              <p><strong>Mission:</strong> {parsedBrief.company.mission}</p>
            </Card>

            <Card title="ICP" subtitle={parsedBrief.icp.role}>
              <p><strong>Key Pain Points:</strong></p>
              <ul>
                {parsedBrief.icp.painPoints.slice(0, 3).map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </Card>

            <Card title="Positioning" subtitle={parsedBrief.positioning.category}>
              <p>{parsedBrief.positioning.differentiation}</p>
            </Card>

            <Card title="Personality">
              <div className="trait-tags">
                {parsedBrief.personality.traits.map((trait, i) => (
                  <span key={i} className="tag tag-primary">{trait}</span>
                ))}
              </div>
            </Card>

            <Card title="Visual Direction">
              <div className="color-preview">
                <div className="color-swatch" style={{ background: parsedBrief.visual.colors.primary }}>
                  <span>Primary</span>
                </div>
                <div className="color-swatch" style={{ background: parsedBrief.visual.colors.secondary }}>
                  <span>Secondary</span>
                </div>
                <div className="color-swatch" style={{ background: parsedBrief.visual.colors.accent }}>
                  <span>Accent</span>
                </div>
              </div>
            </Card>

            <Card title="Anti-Patterns">
              <ul>
                {parsedBrief.personality.antiPatterns.slice(0, 3).map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
