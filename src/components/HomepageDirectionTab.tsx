import { HomepageDirection } from '../types';
import { Card } from './Card';
import './HomepageDirectionTab.css';

interface HomepageDirectionTabProps {
  data: HomepageDirection | null;
}

export function HomepageDirectionTab({ data }: HomepageDirectionTabProps) {
  if (!data) {
    return (
      <div className="homepage-direction-tab">
        <div className="tab-header">
          <h1>Homepage Direction</h1>
          <p>Messaging and layout guidance for your homepage.</p>
        </div>
        <div className="empty-state">
          <div className="empty-state-icon">🏠</div>
          <h3>No Homepage Direction Generated</h3>
          <p>Return to Brand Brief and click "Generate Brand System" to create your homepage direction.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="homepage-direction-tab">
      <div className="tab-header">
        <h1>Homepage Direction</h1>
        <p>Strategic messaging framework and layout guidance for your homepage.</p>
      </div>

      <div className="hero-preview">
        <div className="preview-label">Hero Section Preview</div>
        <div className="hero-mock">
          <h1 className="hero-headline">{data.heroHeadline}</h1>
          <p className="hero-subheadline">{data.heroSubheadline}</p>
          <div className="hero-ctas">
            <button className="mock-btn primary">{data.ctaOptions.primary}</button>
            <button className="mock-btn secondary">{data.ctaOptions.secondary}</button>
          </div>
        </div>
      </div>

      <div className="section">
        <h2>Section Architecture</h2>
        <div className="architecture-list">
          {data.sectionArchitecture.map((section) => (
            <div key={section.order} className="architecture-item">
              <span className="section-order">{section.order}</span>
              <div className="section-info">
                <span className="section-name">{section.name}</span>
                <span className="section-purpose">{section.purpose}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="section">
        <h2>Visual Style Direction</h2>
        <div className="style-list">
          {data.visualStyle.map((style, i) => (
            <div key={i} className="style-item">
              <span className="style-bullet">→</span>
              <span>{style}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="section">
        <h2>Content Blocks</h2>
        <div className="content-blocks-grid">
          <Card title="Social Proof" subtitle="Build trust and credibility">
            <ul>
              {data.contentBlocks.socialProof.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </Card>

          <Card title="Product Proof" subtitle="Show, don't tell">
            <ul>
              {data.contentBlocks.productProof.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </Card>

          <Card title="Feature Framing" subtitle="Benefits over features">
            <ul>
              {data.contentBlocks.featureFraming.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </Card>
        </div>
      </div>

      <div className="section">
        <h2>Wireframe Preview</h2>
        <div className="wireframe">
          <div className="wire-section wire-hero">
            <span className="wire-label">Hero</span>
            <div className="wire-headline"></div>
            <div className="wire-subhead"></div>
            <div className="wire-ctas">
              <div className="wire-btn"></div>
              <div className="wire-btn outline"></div>
            </div>
          </div>

          <div className="wire-section wire-problem">
            <span className="wire-label">Problem</span>
            <div className="wire-cards">
              <div className="wire-card"></div>
              <div className="wire-card"></div>
              <div className="wire-card"></div>
            </div>
          </div>

          <div className="wire-section wire-solution">
            <span className="wire-label">Solution</span>
            <div className="wire-split">
              <div className="wire-text-block">
                <div className="wire-line"></div>
                <div className="wire-line short"></div>
                <div className="wire-line"></div>
              </div>
              <div className="wire-image"></div>
            </div>
          </div>

          <div className="wire-section wire-features">
            <span className="wire-label">Features</span>
            <div className="wire-feature-grid">
              <div className="wire-feature"><div className="wire-icon"></div></div>
              <div className="wire-feature"><div className="wire-icon"></div></div>
              <div className="wire-feature"><div className="wire-icon"></div></div>
              <div className="wire-feature"><div className="wire-icon"></div></div>
            </div>
          </div>

          <div className="wire-section wire-proof">
            <span className="wire-label">Social Proof</span>
            <div className="wire-logos">
              <div className="wire-logo"></div>
              <div className="wire-logo"></div>
              <div className="wire-logo"></div>
              <div className="wire-logo"></div>
              <div className="wire-logo"></div>
            </div>
          </div>

          <div className="wire-section wire-cta-final">
            <span className="wire-label">Final CTA</span>
            <div className="wire-headline short"></div>
            <div className="wire-btn center"></div>
          </div>
        </div>
      </div>
    </div>
  );
}
