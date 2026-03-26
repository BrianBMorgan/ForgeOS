import { VoiceStudio } from '../types';
import { Card } from './Card';
import './VoiceStudioTab.css';

interface VoiceStudioTabProps {
  data: VoiceStudio | null;
}

export function VoiceStudioTab({ data }: VoiceStudioTabProps) {
  if (!data) {
    return (
      <div className="voice-studio-tab">
        <div className="tab-header">
          <h1>Voice Studio</h1>
          <p>Brand voice and messaging guidelines.</p>
        </div>
        <div className="empty-state">
          <div className="empty-state-icon">✍️</div>
          <h3>No Voice Guidelines Generated</h3>
          <p>Return to Brand Brief and click "Generate Brand System" to create your voice guidelines.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="voice-studio-tab">
      <div className="tab-header">
        <h1>Voice Studio</h1>
        <p>Comprehensive voice and messaging guidelines for consistent communication.</p>
      </div>

      <div className="section">
        <h2>Voice Attributes</h2>
        <div className="attributes-grid">
          {data.voiceAttributes.map((attr, i) => (
            <div key={i} className="attribute-item">
              <span className="attribute-number">{i + 1}</span>
              <span className="attribute-text">{attr}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="section">
        <h2>Writing Rules</h2>
        <div className="rules-list">
          {data.writingRules.map((rule, i) => (
            <div key={i} className="rule-item">
              <span className="rule-bullet">✓</span>
              <span>{rule}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="section-grid two-col">
        <Card title="Words to Use" className="words-card use">
          <div className="word-tags">
            {data.wordsToUse.map((word, i) => (
              <span key={i} className="word-tag use">{word}</span>
            ))}
          </div>
        </Card>

        <Card title="Words to Avoid" className="words-card avoid">
          <div className="word-tags">
            {data.wordsToAvoid.map((word, i) => (
              <span key={i} className="word-tag avoid">{word}</span>
            ))}
          </div>
        </Card>
      </div>

      <div className="section">
        <h2>Sample Headlines</h2>
        <div className="samples-list">
          {data.sampleHeadlines.map((headline, i) => (
            <div key={i} className="sample-headline">
              <span className="sample-number">{String(i + 1).padStart(2, '0')}</span>
              <span className="sample-text">{headline}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="section">
        <h2>Sample Product Copy</h2>
        <div className="copy-samples">
          {data.sampleProductCopy.map((copy, i) => (
            <div key={i} className="copy-sample">
              <p>{copy}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="section">
        <h2>Sample CTAs</h2>
        <div className="cta-samples">
          {data.sampleCTAs.map((cta, i) => (
            <button key={i} className="sample-cta">{cta}</button>
          ))}
        </div>
      </div>

      <div className="section">
        <h2>Before & After</h2>
        <div className="before-after">
          <div className="ba-column before">
            <div className="ba-label">
              <span className="ba-icon">✗</span>
              Before
            </div>
            <p>{data.beforeAfter.before}</p>
          </div>
          <div className="ba-arrow">→</div>
          <div className="ba-column after">
            <div className="ba-label">
              <span className="ba-icon">✓</span>
              After
            </div>
            <p>{data.beforeAfter.after}</p>
          </div>
        </div>
        <div className="ba-explanation">
          <strong>Why it works:</strong> {data.beforeAfter.explanation}
        </div>
      </div>
    </div>
  );
}
