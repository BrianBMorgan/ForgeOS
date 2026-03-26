import { useEffect, useState } from 'react';
import { useApp } from '../../context/AppContext';
import './ActiveRun.css';

const stageMessages: Record<string, string[]> = {
  ingest: [
    'Initializing signal collectors...',
    'Parsing domain structure...',
    'Extracting page metadata...'
  ],
  brain: [
    'Querying Brain for existing profiles...',
    'Checking cache freshness...',
    'Validating stored context...'
  ],
  scrape: [
    'Crawling primary site content...',
    'Analyzing competitor positioning...',
    'Extracting voice patterns...'
  ],
  synthesize: [
    'Building voice profile...',
    'Generating persona models...',
    'Mapping competitive whitespace...'
  ],
  save: [
    'Structuring brand profile...',
    'Persisting to Brain...',
    'Indexing for future retrieval...'
  ]
};

export function ActiveRun() {
  const { processingStages, analysisInput } = useApp();
  const [elapsedTime, setElapsedTime] = useState(0);
  const [activityLog, setActivityLog] = useState<{ time: number; message: string }[]>([]);

  const currentStage = processingStages.find(s => s.status === 'running');
  const completedCount = processingStages.filter(s => s.status === 'complete').length;
  const progress = (completedCount / processingStages.length) * 100;

  useEffect(() => {
    const startTime = Date.now();
    const timer = setInterval(() => {
      setElapsedTime(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (currentStage) {
      const messages = stageMessages[currentStage.id] || [];
      let messageIndex = 0;

      const addMessage = () => {
        if (messageIndex < messages.length) {
          setActivityLog(prev => [...prev, { time: elapsedTime, message: messages[messageIndex] }]);
          messageIndex++;
        }
      };

      addMessage();
      const interval = setInterval(addMessage, 800);

      return () => clearInterval(interval);
    }
  }, [currentStage?.id]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="active-run">
      <div className="run-header">
        <div className="run-title-section">
          <h2 className="view-title">Context Agent Running</h2>
          <p className="view-description">
            Analyzing {analysisInput.brandUrl.replace(/^https?:\/\//, '').replace(/\/$/, '') || 'brand'}
          </p>
        </div>
        <div className="elapsed-time">
          <span className="time-label">Elapsed</span>
          <span className="time-value">{formatTime(elapsedTime)}</span>
        </div>
      </div>

      <div className="progress-section">
        <div className="progress-header">
          <span className="progress-label">Analysis Progress</span>
          <span className="progress-percent">{Math.round(progress)}%</span>
        </div>
        <div className="progress-bar">
          <div className="progress-fill" style={{ width: `${progress}%` }} />
        </div>
      </div>

      <div className="stages-section">
        <h3 className="section-title">Processing Stages</h3>
        <div className="stages-list">
          {processingStages.map((stage, index) => (
            <div key={stage.id} className={`stage-item ${stage.status}`}>
              <div className="stage-indicator">
                {stage.status === 'complete' && <span className="stage-check">✓</span>}
                {stage.status === 'running' && <span className="stage-spinner" />}
                {stage.status === 'pending' && <span className="stage-number">{index + 1}</span>}
                {stage.status === 'error' && <span className="stage-error">!</span>}
              </div>
              <div className="stage-content">
                <span className="stage-name">{stage.name}</span>
                {stage.status === 'running' && (
                  <span className="stage-status">Processing...</span>
                )}
                {stage.status === 'complete' && (
                  <span className="stage-status complete">Complete</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="activity-section">
        <h3 className="section-title">Activity Log</h3>
        <div className="activity-log">
          {activityLog.length === 0 ? (
            <div className="activity-empty">Waiting for activity...</div>
          ) : (
            activityLog.map((entry, index) => (
              <div key={index} className="activity-entry">
                <span className="activity-time">{formatTime(entry.time)}</span>
                <span className="activity-message">{entry.message}</span>
              </div>
            ))
          )}
        </div>
      </div>

      {analysisInput.checkBrainFirst && (
        <div className="brain-check-panel">
          <div className="panel-header">
            <span className="panel-icon">◉</span>
            <span className="panel-title">Brain Check</span>
          </div>
          <div className="panel-content">
            <p className="panel-text">
              Looking for existing profile for this brand...
            </p>
            {completedCount >= 2 && (
              <div className="cache-result">
                <span className="cache-badge new">No Cache Hit</span>
                <span className="cache-message">Running fresh analysis</span>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="signals-section">
        <h3 className="section-title">Retrieved Signals</h3>
        <div className="signals-grid">
          {completedCount >= 1 && (
            <div className="signal-card fade-in">
              <div className="signal-source">Domain Analysis</div>
              <div className="signal-value">Primary site crawled</div>
              <div className="signal-confidence">
                <span className="confidence-bar" style={{ width: '95%' }} />
              </div>
            </div>
          )}
          {completedCount >= 3 && analysisInput.competitorUrls.length > 0 && (
            <div className="signal-card fade-in">
              <div className="signal-source">Competitor Data</div>
              <div className="signal-value">{analysisInput.competitorUrls.length} competitors analyzed</div>
              <div className="signal-confidence">
                <span className="confidence-bar" style={{ width: '88%' }} />
              </div>
            </div>
          )}
          {completedCount >= 4 && (
            <div className="signal-card fade-in">
              <div className="signal-source">Voice Profile</div>
              <div className="signal-value">5 tone attributes extracted</div>
              <div className="signal-confidence">
                <span className="confidence-bar" style={{ width: '92%' }} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
