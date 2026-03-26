import { useApp } from '../context/AppContext';
import { ViewType } from '../types';
import './Sidebar.css';

interface NavItem {
  id: ViewType;
  label: string;
  icon: string;
}

const navItems: NavItem[] = [
  { id: 'new-analysis', label: 'New Analysis', icon: '⊕' },
  { id: 'active-run', label: 'Active Run', icon: '◎' },
  { id: 'brand-profile', label: 'Brand Profile', icon: '◈' },
  { id: 'strategy', label: 'Strategy', icon: '◇' },
  { id: 'brain-history', label: 'Brain History', icon: '◉' }
];

export function Sidebar() {
  const { currentView, setCurrentView, sidebarCollapsed, setSidebarCollapsed, isProcessing, brandProfile } = useApp();

  const getItemStatus = (id: ViewType): 'active' | 'available' | 'disabled' => {
    if (id === currentView) return 'active';
    if (id === 'active-run' && !isProcessing) return 'disabled';
    if ((id === 'brand-profile' || id === 'strategy') && !brandProfile) return 'disabled';
    return 'available';
  };

  return (
    <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-header">
        <div className="sidebar-brand">
          <span className="sidebar-logo">◈</span>
          {!sidebarCollapsed && <span className="sidebar-title">Forge</span>}
        </div>
        <button 
          className="sidebar-toggle"
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {sidebarCollapsed ? '→' : '←'}
        </button>
      </div>

      <nav className="sidebar-nav">
        {navItems.map(item => {
          const status = getItemStatus(item.id);
          return (
            <button
              key={item.id}
              className={`nav-item ${status}`}
              onClick={() => status !== 'disabled' && setCurrentView(item.id)}
              disabled={status === 'disabled'}
              title={sidebarCollapsed ? item.label : undefined}
            >
              <span className="nav-icon">{item.icon}</span>
              {!sidebarCollapsed && <span className="nav-label">{item.label}</span>}
              {item.id === 'active-run' && isProcessing && (
                <span className="nav-badge pulse">●</span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="sidebar-footer">
        {!sidebarCollapsed && (
          <div className="sidebar-status">
            <span className="status-dot connected"></span>
            <span className="status-text">Brain Connected</span>
          </div>
        )}
      </div>
    </aside>
  );
}
