import { useState } from "react";
function App() {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className="shell">
        <aside className={`sidebar ${collapsed ? "collapsed" : ""}`}>
        <div className="logo">FORGEOS</div>
        <nav className="nav">
          <div className="nav-item active">
            <span className="nav-icon">⌘</span>
            <span className="nav-label">Console</span>
          </div>
          <div className="nav-item">
            <span className="nav-icon">∿</span>
            <span className="nav-label">Signals</span>
          </div>
          <div className="nav-item">
            <span className="nav-icon">◼</span>
            <span className="nav-label">Modules</span>
          </div>
          <div className="nav-item">
            <span className="nav-icon">⚙</span>
            <span className="nav-label">Settings</span>
          </div>
        </nav>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <button
            className="toggle"
            onClick={() => setCollapsed(!collapsed)}
          >
            ☰
          </button>
          <div className="status">System Kernel Online</div>
        </header>

        <main className="viewport">
          <div className="canvas">
            Cockpit Viewport
          </div>
        </main>

        <section className="command">
          <input
            className="command-input"
            placeholder="Enter command..."
          />
        </section>
      </div>
    </div>
  );
}

export default App;