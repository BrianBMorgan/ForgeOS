import { useState } from "react";
import logo from "./ForgeOS_1772241278038.png";
import PromptColumn from "./components/PromptColumn";
import Workspace from "./components/Workspace";

type NavId = "new-build" | "active-runs" | "templates" | "logs" | "settings";

const navItems: { id: NavId; label: string; icon: string }[] = [
  { id: "new-build", label: "New Build", icon: "+" },
  { id: "active-runs", label: "Active Runs", icon: "▶" },
  { id: "templates", label: "Templates", icon: "❖" },
  { id: "logs", label: "Logs", icon: "☰" },
  { id: "settings", label: "Settings", icon: "⚙" },
];

function App() {
  const [collapsed, setCollapsed] = useState(false);
  const [activeNav, setActiveNav] = useState<NavId>("new-build");

  return (
    <div className="shell">
      <aside className={`sidebar ${collapsed ? "collapsed" : ""}`}>
        <div className="logo">
          <img src={logo} alt="ForgeOS" className="logo-img" />
        </div>
        <nav className="nav">
          {navItems.map((item) => (
            <div
              key={item.id}
              className={`nav-item ${activeNav === item.id ? "active" : ""}`}
              onClick={() => setActiveNav(item.id)}
            >
              <span className="nav-icon">{item.icon}</span>
              <span className="nav-label">{item.label}</span>
            </div>
          ))}
        </nav>
      </aside>

      <div className="main-area">
        <header className="topbar">
          <button
            className="toggle"
            onClick={() => setCollapsed(!collapsed)}
          >
            ☰
          </button>
          <div className="status">System Kernel Online</div>
        </header>

        <div className="content-split">
          <PromptColumn />
          <Workspace />
        </div>
      </div>
    </div>
  );
}

export default App;
