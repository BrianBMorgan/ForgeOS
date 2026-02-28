const express = require("express");
const path = require("path");
const {
  createRun,
  executePipeline,
  handleApproval,
  handleRejection,
  getRun,
  getRunSync,
  getAllRuns,
} = require("./pipeline/runner");
const workspace = require("./workspace/manager");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/api/runs", (req, res) => {
  const { prompt } = req.body;
  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({ error: "Prompt is required" });
  }

  const run = createRun(prompt.trim());

  executePipeline(run.id).catch((err) => {
    console.error(`Pipeline error for run ${run.id}:`, err);
  });

  res.status(201).json({ id: run.id, status: run.status });
});

app.get("/api/runs", (_req, res) => {
  const runs = getAllRuns();
  res.json(runs);
});

app.get("/api/runs/:id", async (req, res) => {
  const run = await getRun(req.params.id);
  if (!run) {
    return res.status(404).json({ error: "Run not found" });
  }
  const liveWs = workspace.getWorkspaceStatus(run.id);
  if (liveWs) {
    run.workspace = { status: liveWs.status, port: liveWs.port, error: liveWs.error };
  }
  res.json(run);
});

app.get("/api/runs/:id/logs", (req, res) => {
  const logs = workspace.getWorkspaceLogs(req.params.id);
  const status = workspace.getWorkspaceStatus(req.params.id);
  res.json({ logs, status });
});

app.post("/api/runs/:id/approve", async (req, res) => {
  const result = await handleApproval(req.params.id);
  if (result.error) {
    return res.status(400).json(result);
  }
  res.json(result);
});

app.post("/api/runs/:id/reject", async (req, res) => {
  const { feedback } = req.body;
  if (!feedback || typeof feedback !== "string" || !feedback.trim()) {
    return res.status(400).json({ error: "Feedback is required" });
  }

  const result = await handleRejection(req.params.id, feedback.trim());
  if (result.error) {
    return res.status(400).json(result);
  }
  res.json(result);
});

const projectManager = require("./projects/manager");

app.post("/api/projects", async (req, res) => {
  const { prompt } = req.body;
  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({ error: "Prompt is required" });
  }

  const project = await projectManager.createProject(prompt.trim());
  const run = createRun(prompt.trim(), { projectId: project.id, iterationNumber: 1 });
  await projectManager.addIteration(project.id, run.id, prompt.trim(), 1);

  executePipeline(run.id).catch((err) => {
    console.error(`Pipeline error for project ${project.id}, run ${run.id}:`, err);
    projectManager.updateProjectStatus(project.id, "failed");
  });

  res.status(201).json({ id: project.id, runId: run.id, name: project.name });
});

app.get("/api/projects", async (_req, res) => {
  res.json(await projectManager.getAllProjects());
});

app.get("/api/projects/:id", async (req, res) => {
  const project = await projectManager.getProject(req.params.id);
  if (!project) {
    return res.status(404).json({ error: "Project not found" });
  }

  const currentRun = project.currentRunId ? await getRun(project.currentRunId) : null;
  if (currentRun) {
    const liveWs = workspace.getWorkspaceStatus(currentRun.id);
    if (liveWs) {
      currentRun.workspace = { status: liveWs.status, port: liveWs.port, error: liveWs.error };
    }
    if (currentRun.status === "running" || currentRun.status === "awaiting-approval") {
      await projectManager.updateProjectStatus(project.id, "building");
    } else if (currentRun.status === "failed") {
      await projectManager.updateProjectStatus(project.id, "failed");
    } else if (currentRun.status === "completed") {
      if (currentRun.workspace?.status === "running") {
        await projectManager.updateProjectStatus(project.id, "active");
      } else if (currentRun.workspace?.status === "install-failed" || currentRun.workspace?.status === "start-failed" || currentRun.workspace?.status === "build-failed") {
        await projectManager.updateProjectStatus(project.id, "failed");
      } else {
        await projectManager.updateProjectStatus(project.id, "stopped");
      }
    }
  }

  const iterations = await Promise.all(project.iterations.map(async (iter) => {
    const iterRun = await getRun(iter.runId);
    return {
      ...iter,
      status: iterRun?.status || "unknown",
      workspaceStatus: iterRun?.workspace?.status || null,
    };
  }));

  res.json({ ...project, iterations, currentRun });
});

app.post("/api/projects/:id/iterate", async (req, res) => {
  const { prompt } = req.body;
  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({ error: "Prompt is required" });
  }

  const project = await projectManager.getProject(req.params.id);
  if (!project) {
    return res.status(404).json({ error: "Project not found" });
  }

  const lastRunId = project.currentRunId;
  const existingFiles = lastRunId ? projectManager.captureCurrentFiles(lastRunId) : [];
  const iterationNumber = project.iterations.length + 1;

  const run = createRun(prompt.trim(), {
    projectId: project.id,
    iterationNumber,
    existingFiles,
  });
  await projectManager.addIteration(project.id, run.id, prompt.trim(), iterationNumber);

  executePipeline(run.id).catch((err) => {
    console.error(`Pipeline error for project ${project.id}, iteration ${iterationNumber}:`, err);
    projectManager.updateProjectStatus(project.id, "failed");
  });

  res.status(201).json({ runId: run.id, iterationNumber });
});

app.post("/api/projects/:id/stop", async (req, res) => {
  const project = await projectManager.getProject(req.params.id);
  if (!project) {
    return res.status(404).json({ error: "Project not found" });
  }

  if (project.currentRunId) {
    await workspace.stopApp(project.currentRunId);
  }
  await projectManager.stopProject(req.params.id);
  res.json({ status: "stopped" });
});

const chatManager = require("./chat/manager");

app.post("/api/projects/:id/chat", async (req, res) => {
  const { message } = req.body;
  if (!message || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "Message is required" });
  }

  const project = await projectManager.getProject(req.params.id);
  if (!project) {
    return res.status(404).json({ error: "Project not found" });
  }

  try {
    const response = await chatManager.chat(req.params.id, message.trim());
    res.json(response);
  } catch (err) {
    console.error("Chat error:", err.message);
    res.status(500).json({ error: "Chat failed" });
  }
});

app.get("/api/projects/:id/chat", async (req, res) => {
  const project = await projectManager.getProject(req.params.id);
  if (!project) {
    return res.status(404).json({ error: "Project not found" });
  }

  const history = await chatManager.getChatHistory(req.params.id);
  res.json(history);
});

const { runStressTest, getStressTestStatus } = require("./stress-test/runner");
const { generateReport } = require("./stress-test/report");

let latestReport = null;

app.post("/api/stress-test/start", (req, res) => {
  const status = getStressTestStatus();
  if (status.running) {
    return res.status(409).json({ error: "Stress test already running" });
  }

  const { promptIds } = req.body || {};

  runStressTest({ promptIds })
    .then((results) => {
      latestReport = generateReport(results);
      console.log("Stress test complete. Report saved.");
    })
    .catch((err) => {
      console.error("Stress test error:", err);
    });

  res.json({ started: true, total: getStressTestStatus().total });
});

app.get("/api/stress-test/status", (_req, res) => {
  res.json(getStressTestStatus());
});

app.get("/api/stress-test/results", (_req, res) => {
  if (!latestReport) {
    return res.status(404).json({ error: "No results yet" });
  }
  res.json(latestReport.report || latestReport);
});

const dbUrl = process.env.NEON_DATABASE_URL;
const neonLib = require("@neondatabase/serverless");
const dbViewer = dbUrl ? neonLib.neon(dbUrl) : null;

app.get("/api/db/tables", async (_req, res) => {
  if (!dbViewer) return res.status(503).json({ error: "No database configured" });
  try {
    const tables = await dbViewer`
      SELECT table_name, table_schema
      FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY table_schema, table_name
    `;
    res.json(tables);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/db/tables/:name", async (req, res) => {
  if (!dbViewer) return res.status(503).json({ error: "No database configured" });
  const tableName = req.params.name.replace(/[^a-zA-Z0-9_]/g, "");
  if (!tableName) return res.status(400).json({ error: "Invalid table name" });
  try {
    const columns = await dbViewer`
      SELECT column_name, data_type, is_nullable, column_default, character_maximum_length
      FROM information_schema.columns
      WHERE table_name = ${tableName}
      AND table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY ordinal_position
    `;
    const countResult = await dbViewer.query(`SELECT count(*)::int as total FROM "${tableName}"`);
    res.json({ columns, rowCount: countResult[0]?.total || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/db/tables/:name/rows", async (req, res) => {
  if (!dbViewer) return res.status(503).json({ error: "No database configured" });
  const tableName = req.params.name.replace(/[^a-zA-Z0-9_]/g, "");
  if (!tableName) return res.status(400).json({ error: "Invalid table name" });
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  try {
    const rows = await dbViewer.query(`SELECT * FROM "${tableName}" LIMIT ${limit} OFFSET ${offset}`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/db/query", async (req, res) => {
  if (!dbViewer) return res.status(503).json({ error: "No database configured" });
  const { sql: rawSql } = req.body;
  if (!rawSql || typeof rawSql !== "string") return res.status(400).json({ error: "SQL query required" });

  const trimmed = rawSql.trim().toLowerCase();
  const forbidden = ["drop ", "truncate ", "alter ", "create ", "grant ", "revoke "];
  for (const f of forbidden) {
    if (trimmed.startsWith(f)) {
      return res.status(403).json({ error: `${f.trim().toUpperCase()} statements are not allowed from the viewer` });
    }
  }

  try {
    const startTime = Date.now();
    const rows = await dbViewer.query(rawSql);
    const duration = Date.now() - startTime;
    res.json({ rows, rowCount: rows.length, duration });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const http = require("http");

app.use("/preview/:runId", (req, res) => {
  const runId = req.params.runId;

  const status = workspace.getWorkspaceStatus(runId);
  if (!status || status.status !== "running" || !status.port) {
    return res.status(503).json({ error: "App not running" });
  }

  const basePath = `/preview/${runId}`;
  let targetPath = req.originalUrl;
  if (targetPath.startsWith(basePath)) {
    targetPath = targetPath.slice(basePath.length) || "/";
  }
  if (!targetPath.startsWith("/")) targetPath = "/" + targetPath;

  const options = {
    hostname: "127.0.0.1",
    port: status.port,
    path: targetPath,
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${status.port}` },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on("error", () => {
    res.status(502).json({ error: "Preview app not reachable" });
  });

  req.pipe(proxyReq);
});

if (process.env.NODE_ENV === "production") {
  const clientDist = path.join(__dirname, "..", "client", "dist");
  app.use(express.static(clientDist));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`ForgeOS server running on port ${PORT}`);

  try {
    const allProjects = await projectManager.getAllProjects();
    const activeProjects = allProjects.filter(
      (p) => (p.status === "active" || p.status === "building") && p.currentRunId
    );
    if (activeProjects.length > 0) {
      console.log(`Restoring ${activeProjects.length} workspace(s)...`);
      for (const project of activeProjects) {
        try {
          const run = await getRun(project.currentRunId);
          if (!run || run.status !== "completed") {
            await projectManager.updateProjectStatus(project.id, "stopped");
            continue;
          }
          const executorOutput = run.stages?.executor?.output;
          if (!executorOutput || !executorOutput.startCommand) {
            await projectManager.updateProjectStatus(project.id, "stopped");
            continue;
          }
          const result = await workspace.restoreWorkspace(
            run.id,
            executorOutput.startCommand,
            executorOutput.port || 4000
          );
          if (result.success) {
            run.workspace = { status: "running", port: result.port, error: null };
            await projectManager.updateProjectStatus(project.id, "active");
            console.log(`  Restored workspace for "${project.name}" on port ${result.port}`);
          } else {
            run.workspace = { status: "stopped", port: null, error: result.error };
            await projectManager.updateProjectStatus(project.id, "stopped");
            console.log(`  Failed to restore "${project.name}": ${result.error}`);
          }
        } catch (err) {
          console.error(`  Error restoring "${project.name}":`, err.message);
          await projectManager.updateProjectStatus(project.id, "stopped");
        }
      }
    }
  } catch (err) {
    console.error("Workspace restoration error:", err.message);
  }
});
