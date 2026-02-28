import Console from "./modules/Console";
import Signals from "./modules/Signals";
import Modules from "./modules/Modules";
import Settings from "./modules/Settings";
import { useState } from "react";
import logo from "./ForgeOS_1772241278038.png";
function App() {
  const modules = [
    { id: "console", label: "Console", icon: "⌘", component: Console },
    { id: "signals", label: "Signals", icon: "◉", component: Signals },
    { id: "modules", label: "Modules", icon: "◼", component: Modules },
    { id: "settings", label: "Settings", icon: "⚙", component: Settings },
  ] as const;

  type ModuleId = "console" | "signals" | "modules" | "settings";

  const [collapsed, setCollapsed] = useState(false);
  const [activeModule, setActiveModule] = useState<ModuleId>("console");
  const [command, setCommand] = useState("");
  const [output, setOutput] = useState<string[]>([]);
  function dispatchCommand(command: { name: string; args: string[] }) {
    setOutput(prev => [
      ...prev,
      `> ${command.name} ${command.args.join(" ")}`,
      `Command received.`
    ]);
  }
  function handleCommand(input: string) {
      if (!input.trim()) return;

      const parts = input.trim().split(" ");
      const name = parts[0].toLowerCase();
      const args = parts.slice(1);

      dispatchCommand({ name, args });
    }
  return (
    <div className="shell">
        <aside className={`sidebar ${collapsed ? "collapsed" : ""}`}>
          <div className="logo">
            <img src={logo} alt="ForgeOS" className="logo-img" />
          </div>
          <nav className="nav">
            {modules.map((module) => (
              <div
                key={module.id}
                className={`nav-item ${
                  activeModule === module.id ? "active" : ""
                }`}
                onClick={() => setActiveModule(module.id)}
              >
                <span className="nav-icon">{module.icon}</span>
                <span className="nav-label">{module.label}</span>
              </div>
            ))}
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
            <div className="terminal-output">
              {output.map((line, index) => (
                <div key={index}>{line}</div>
              ))}
            </div>

            {(() => {
              const active = modules.find((m) => m.id === activeModule);
              if (!active) return null;

              const ActiveComponent = active.component;
              return <ActiveComponent />;
            })()}
          </div>
        </main>

        <section className="command">
          <input
            className="command-input"
            placeholder="Enter command..."
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                handleCommand(command);
                setCommand("");
              }
            }}
          />
        </section>
      </div>
    </div>
  );
}
export default App;