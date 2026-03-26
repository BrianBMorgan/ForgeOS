import { useApp } from '../../context/AppContext';
import './Strategy.css';

export function Strategy() {
  const { brandProfile } = useApp();

  if (!brandProfile) {
    return (
      <div className="strategy empty-state">
        <div className="empty-icon">◇</div>
        <h2 className="empty-title">No Strategy Available</h2>
        <p className="empty-description">
          Complete a brand analysis to generate strategic recommendations.
        </p>
      </div>
    );
  }

  const getImpactLabel = (impact: string) => {
    switch (impact) {
      case 'high': return 'High Impact';
      case 'medium': return 'Medium Impact';
      case 'low': return 'Low Impact';
      default: return impact;
    }
  };

  const getEffortLabel = (effort: string) => {
    switch (effort) {
      case 'high': return 'High Effort';
      case 'medium': return 'Medium Effort';
      case 'low': return 'Low Effort';
      default: return effort;
    }
  };

  // Group recommendations by category
  const groupedRecs = brandProfile.strategicRecommendations.reduce((acc, rec) => {
    if (!acc[rec.category]) {
      acc[rec.category] = [];
    }
    acc[rec.category].push(rec);
    return acc;
  }, {} as Record<string, typeof brandProfile.strategicRecommendations>);

  // Derive additional strategic content from brand profile
  const messagingOpportunities = [
    {
      theme: 'Intelligence over Generation',
      description: 'Position as the thinking layer that makes all marketing smarter, not just another content tool.',
      source: 'Voice Profile Analysis'
    },
    {
      theme: 'Context as Competitive Advantage',
      description: 'Emphasize persistent brand memory as the key differentiator from stateless AI tools.',
      source: 'Competitive Whitespace'
    },
    {
      theme: 'Strategic Partner Positioning',
      description: 'Communicate expertise and partnership rather than vendor relationships.',
      source: 'Tone Attribute: Strategic (88/100)'
    }
  ];

  const contentThemes = [
    'The hidden cost of brand inconsistency at scale',
    'Why context matters more than content volume',
    'Moving from reactive marketing to strategic positioning',
    'Building brand equity in the age of AI'
  ];

  const nextActions = [
    {
      action: 'Define category positioning',
      priority: 'high',
      description: 'Establish "Brand Intelligence" as a distinct category Forge owns'
    },
    {
      action: 'Develop ICP-specific messaging',
      priority: 'high',
      description: 'Create tailored value propositions for each identified persona'
    },
    {
      action: 'Create thought leadership content',
      priority: 'medium',
      description: 'Publish content series on brand consistency and strategic positioning'
    },
    {
      action: 'Surface Brain as feature',
      priority: 'medium',
      description: 'Make persistent memory a visible, trustworthy product feature'
    }
  ];

  return (
    <div className="strategy">
      <div className="strategy-header">
        <div className="header-info">
          <h2 className="view-title">Strategic Recommendations</h2>
          <p className="view-description">
            Actionable insights derived from the {brandProfile.brandName} brand intelligence profile
          </p>
        </div>
        <div className="header-meta">
          <span className="meta-badge">
            {brandProfile.strategicRecommendations.length} Recommendations
          </span>
        </div>
      </div>

      {/* Priority Matrix */}
      <section className="strategy-section">
        <h3 className="section-title">Priority Matrix</h3>
        <div className="priority-matrix">
          {brandProfile.strategicRecommendations.map((rec) => (
            <div 
              key={rec.id} 
              className={`matrix-card impact-${rec.impact} effort-${rec.effort}`}
            >
              <div className="matrix-header">
                <span className="rec-category">{rec.category}</span>
                <div className="matrix-badges">
                  <span className={`impact-badge ${rec.impact}`}>
                    {getImpactLabel(rec.impact)}
                  </span>
                  <span className={`effort-badge ${rec.effort}`}>
                    {getEffortLabel(rec.effort)}
                  </span>
                </div>
              </div>
              <h4 className="rec-title">{rec.title}</h4>
              <p className="rec-description">{rec.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Messaging Opportunities */}
      <section className="strategy-section">
        <h3 className="section-title">Messaging Opportunities</h3>
        <div className="messaging-grid">
          {messagingOpportunities.map((opp, idx) => (
            <div key={idx} className="messaging-card">
              <div className="messaging-source">{opp.source}</div>
              <h4 className="messaging-theme">{opp.theme}</h4>
              <p className="messaging-description">{opp.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Content Themes */}
      <section className="strategy-section">
        <h3 className="section-title">Suggested Content Themes</h3>
        <div className="content-themes">
          {contentThemes.map((theme, idx) => (
            <div key={idx} className="theme-item">
              <span className="theme-number">{String(idx + 1).padStart(2, '0')}</span>
              <span className="theme-text">{theme}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Recommendations by Category */}
      <section className="strategy-section">
        <h3 className="section-title">Recommendations by Category</h3>
        <div className="category-groups">
          {Object.entries(groupedRecs).map(([category, recs]) => (
            <div key={category} className="category-group">
              <h4 className="category-title">{category}</h4>
              <div className="category-recs">
                {recs.map((rec) => (
                  <div key={rec.id} className="category-rec-item">
                    <div className="rec-indicator"></div>
                    <div className="rec-content">
                      <span className="rec-item-title">{rec.title}</span>
                      <span className="rec-item-description">{rec.description}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Next Actions */}
      <section className="strategy-section">
        <h3 className="section-title">Recommended Next Actions</h3>
        <div className="actions-list">
          {nextActions.map((action, idx) => (
            <div key={idx} className={`action-item priority-${action.priority}`}>
              <div className="action-number">{idx + 1}</div>
              <div className="action-content">
                <div className="action-header">
                  <span className="action-name">{action.action}</span>
                  <span className={`action-priority ${action.priority}`}>
                    {action.priority}
                  </span>
                </div>
                <p className="action-description">{action.description}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Export Section */}
      <div className="strategy-actions">
        <button className="btn-export">
          Export Strategy Brief
        </button>
      </div>
    </div>
  );
}
