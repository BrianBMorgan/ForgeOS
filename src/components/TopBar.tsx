import { useApp } from '../context/AppContext';
import './TopBar.css';

const viewTitles: Record<string, string> = {
  'new-analysis': 'New Analysis',
  'active-run': 'Active Run',
  'brand-profile': 'Brand Profile',
  'strategy': 'Strategy',
  'brain-history': 'Brain History'
};

export function TopBar() {
  const { currentView, brandProfile, sidebarCollapsed, setSidebarCollapsed } = useApp();

  return (
    <header className="topbar">
      <div className="topbar-left">
        <button 
          className="mobile-menu-btn"
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          aria-label="Toggle menu"
        >
          ☰
        </button>
        <h1 className="topbar-title">{viewTitles[currentView]}</h1>
        {brandProfile && currentView === 'brand-profile' && (
          <span className="topbar-subtitle">
            {brandProfile.brandName} · v{brandProfile.version}
          </span>
        )}
      </div>

      <div className="topbar-right">
        {brandProfile && (
          <div className={`cache-indicator ${brandProfile.cacheStatus}`}>
            <span className="cache-dot"></span>
            <span className="cache-label">
              {brandProfile.cacheStatus === 'fresh' ? 'Fresh' : 
               brandProfile.cacheStatus === 'cached' ? 'Cached' : 'Stale'}
            </span>
          </div>
        )}
        <div className="user-area">
          <span className="user-avatar">◯</span>
        </div>
      </div>
    </header>
  );
}
