import { AlignmentReport } from '../types';
import { Card } from './Card';
import './AlignmentReportTab.css';

interface AlignmentReportTabProps {
  data: AlignmentReport | null;
}

function ScoreCard({ label, score }: { label: string; score: number }) {
  const getScoreColor = (s: number) => {
    if (s >= 85) return 'var(--color-success)';
    if (s >= 70) return 'var(--color-primary)';
    if (s >= 50) return 'var(--color-warning)';
    return 'var(--color-error)';
  };

  return (
    <div className="score-card">
      <div className="score-value" style={{ color: getScoreColor(score) }}>
        {score}
      </div>
      <div className="score-label">{label}</div>
      <div className="score-bar">
        <div 
          className="score-fill" 
          style={{ 
            width: `${score}%`,
            backgroundColor: getScoreColor(score)
          }} 
        />
      </div>
    </div>
  );
}

export function AlignmentReportTab({ data }: AlignmentReportTabProps) {
  if (!data) {
    return (
      <div className="alignment-report-tab">
        <div className="tab-header">
          <h1>Alignment Report</h1>
          <p>Evaluate how well the generated system matches your brief.</p>
        </div>
        <div className="empty-state">
          <div className="empty-state-icon">📊</div>
          <h3>No Alignment Report Generated</h3>
          <p>Return to Brand Brief and click "Generate Brand System" to create your alignment report.</p>
        </div>
      </div>
    );
  }

  const totalScore = Math.round(
    (data.scores.icpFit + 
     data.scores.positioningClarity + 
     data.scores.visualCoherence + 
     data.scores.voiceConsistency + 
     data.scores.differentiation) / 5
  );

  return (
    <div className="alignment-report-tab">
      <div className="tab-header">
        <h1>Alignment Report</h1>
        <p>Analysis of how well the generated brand system aligns with your brief.</p>
      </div>

      <div className="overall-score">
        <div className="overall-value">{totalScore}</div>
        <div className="overall-label">Overall Alignment Score</div>
        <div className="overall-description">
          {totalScore >= 85 ? 'Excellent alignment with your brand brief' :
           totalScore >= 70 ? 'Strong alignment with minor areas for refinement' :
           totalScore >= 50 ? 'Moderate alignment — review recommended refinements' :
           'Low alignment — consider revising the brand brief'}
        </div>
      </div>

      <div className="section">
        <h2>Score Breakdown</h2>
        <div className="scores-grid">
          <ScoreCard label="ICP Fit" score={data.scores.icpFit} />
          <ScoreCard label="Positioning Clarity" score={data.scores.positioningClarity} />
          <ScoreCard label="Visual Coherence" score={data.scores.visualCoherence} />
          <ScoreCard label="Voice Consistency" score={data.scores.voiceConsistency} />
          <ScoreCard label="Differentiation" score={data.scores.differentiation} />
        </div>
      </div>

      <div className="section-grid three-col">
        <Card title="What Matches Well" className="matches-card">
          <ul>
            {data.matches.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </Card>

        <Card title="Where It Drifts" className="drifts-card">
          <ul>
            {data.drifts.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </Card>

        <Card title="Recommended Refinements" className="refinements-card">
          <ul>
            {data.refinements.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </Card>
      </div>

      <div className="section">
        <h2>Radar View</h2>
        <div className="radar-container">
          <svg viewBox="0 0 300 300" className="radar-chart">
            {/* Background rings */}
            {[100, 80, 60, 40, 20].map((r, i) => (
              <circle
                key={i}
                cx="150"
                cy="150"
                r={r}
                fill="none"
                stroke="var(--color-border-subtle)"
                strokeWidth="1"
              />
            ))}
            
            {/* Axis lines */}
            {[0, 72, 144, 216, 288].map((angle, i) => {
              const rad = (angle - 90) * Math.PI / 180;
              return (
                <line
                  key={i}
                  x1="150"
                  y1="150"
                  x2={150 + 100 * Math.cos(rad)}
                  y2={150 + 100 * Math.sin(rad)}
                  stroke="var(--color-border-subtle)"
                  strokeWidth="1"
                />
              );
            })}
            
            {/* Data polygon */}
            <polygon
              points={[
                data.scores.icpFit,
                data.scores.positioningClarity,
                data.scores.visualCoherence,
                data.scores.voiceConsistency,
                data.scores.differentiation
              ].map((score, i) => {
                const angle = (i * 72 - 90) * Math.PI / 180;
                const r = score;
                return `${150 + r * Math.cos(angle)},${150 + r * Math.sin(angle)}`;
              }).join(' ')}
              fill="rgba(59, 130, 246, 0.2)"
              stroke="var(--color-primary)"
              strokeWidth="2"
            />
            
            {/* Data points */}
            {[
              data.scores.icpFit,
              data.scores.positioningClarity,
              data.scores.visualCoherence,
              data.scores.voiceConsistency,
              data.scores.differentiation
            ].map((score, i) => {
              const angle = (i * 72 - 90) * Math.PI / 180;
              const r = score;
              return (
                <circle
                  key={i}
                  cx={150 + r * Math.cos(angle)}
                  cy={150 + r * Math.sin(angle)}
                  r="5"
                  fill="var(--color-primary)"
                />
              );
            })}
          </svg>
          
          <div className="radar-labels">
            <span className="radar-label" style={{ top: '0', left: '50%', transform: 'translateX(-50%)' }}>
              ICP Fit
            </span>
            <span className="radar-label" style={{ top: '38%', right: '0' }}>
              Positioning
            </span>
            <span className="radar-label" style={{ bottom: '10%', right: '10%' }}>
              Visual
            </span>
            <span className="radar-label" style={{ bottom: '10%', left: '10%' }}>
              Voice
            </span>
            <span className="radar-label" style={{ top: '38%', left: '0' }}>
              Differentiation
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
