import { TabId } from '../types';
import './Sidebar.css';

interface SidebarProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  hasGeneratedSystem: boolean;
}

const navItems: { id: TabId; label: string; icon: string }[] = [
  { id: 'brief', label: 'Brand Brief', icon: '📋' },
  { id: 'visual', label: 'Visual Identity', icon: '🎨' },
  { id: 'homepage', label: 'Homepage Direction', icon: '🏠' },
  { id: 'voice', label: 'Voice Studio', icon: '✍️' },
  { id: 'alignment', label: 'Alignment Report', icon: '📊' },
];

export function Sidebar({ activeTab, onTabChange, hasGeneratedSystem }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="logo">
          <span className="logo-icon">◇</span>
          <span className="logo-text">Forge Canvas</span>
        </div>
        <p className="logo-tagline">Brand System Generator</p>
      </div>
      
      <nav className="sidebar-nav">
        {navItems.map((item) => (
          <button
            key={item.id}
            className={`nav-item ${activeTab === item.id ? 'active' : ''} ${
              item.id !== 'brief' && !hasGeneratedSystem ? 'disabled' : ''
            }`}
            onClick={() => {
              if (item.id === 'brief' || hasGeneratedSystem) {
                onTabChange(item.id);
              }
            }}
          >
            <span className="nav-icon">{item.icon}</span>
            <span className="nav-label">{item.label}</span>
            {item.id !== 'brief' && !hasGeneratedSystem && (
              <span className="nav-lock">🔒</span>
            )}
          </button>
        ))}
      </nav>

      <div className="sidebar-footer">
        <p className="sidebar-credit">Part of Forge Intelligence</p>
      </div>
    </aside>
  );
}
