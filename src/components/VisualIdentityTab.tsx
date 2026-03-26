import { VisualIdentity } from '../types';
import { Card } from './Card';
import './VisualIdentityTab.css';

interface VisualIdentityTabProps {
  data: VisualIdentity | null;
}

export function VisualIdentityTab({ data }: VisualIdentityTabProps) {
  if (!data) {
    return (
      <div className="visual-identity-tab">
        <div className="tab-header">
          <h1>Visual Identity</h1>
          <p>Design system direction based on your brand brief.</p>
        </div>
        <div className="empty-state">
          <div className="empty-state-icon">🎨</div>
          <h3>No Visual Identity Generated</h3>
          <p>Return to Brand Brief and click "Generate Brand System" to create your visual identity direction.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="visual-identity-tab">
      <div className="tab-header">
        <h1>Visual Identity</h1>
        <p>Design system direction derived from your brand positioning and ICP needs.</p>
      </div>

      <div className="section">
        <h2>Brand Traits</h2>
        <div className="trait-list">
          {data.brandTraits.map((trait, i) => (
            <span key={i} className="tag tag-primary">{trait}</span>
          ))}
        </div>
      </div>

      <div className="section-grid two-col">
        <Card title="Typography Direction">
          <div className="font-direction">
            <div className="font-item">
              <span className="font-label">Primary</span>
              <p>{data.fontDirection.primary}</p>
            </div>
            <div className="font-item">
              <span className="font-label">Secondary</span>
              <p>{data.fontDirection.secondary}</p>
            </div>
            <div className="font-rationale">
              <strong>Rationale:</strong> {data.fontDirection.rationale}
            </div>
          </div>
        </Card>

        <Card title="UI Shape Language">
          <div className="shape-direction">
            <div className="shape-item">
              <span className="shape-label">Border Radius</span>
              <span className="shape-value">{data.uiShapes.borderRadius}</span>
            </div>
            <div className="shape-item">
              <span className="shape-label">Style</span>
              <p>{data.uiShapes.style}</p>
            </div>
            <div className="shape-rationale">
              <strong>Rationale:</strong> {data.uiShapes.rationale}
            </div>
          </div>
        </Card>
      </div>

      <div className="section">
        <h2>Color Palette</h2>
        <div className="color-palette">
          {data.colorPalette.map((color, i) => (
            <div key={i} className="palette-item">
              <div 
                className="palette-swatch" 
                style={{ backgroundColor: color.hex }}
              />
              <div className="palette-info">
                <span className="palette-name">{color.name}</span>
                <code className="palette-hex">{color.hex}</code>
                <p className="palette-usage">{color.usage}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="section">
        <h2>Layout Principles</h2>
        <div className="principles-grid">
          {data.layoutPrinciples.map((principle, i) => (
            <div key={i} className="principle-item">
              <span className="principle-number">{String(i + 1).padStart(2, '0')}</span>
              <span className="principle-text">{principle}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="section-grid two-col">
        <Card title="Imagery Direction">
          <ul>
            {data.imageryDirection.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </Card>

        <Card title="Motion Direction">
          <ul>
            {data.motionDirection.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </Card>
      </div>

      <div className="section">
        <Card title="Anti-Patterns to Avoid" className="warning-card">
          <ul className="anti-pattern-list">
            {data.antiPatterns.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </Card>
      </div>

      <div className="section">
        <Card title="Design Rationale" subtitle="Why these choices fit your brand">
          <p className="rationale-text">{data.designRationale}</p>
        </Card>
      </div>
    </div>
  );
}
