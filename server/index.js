const express = require("express");
const path = require("path");
const {
  createRun,
  executePipeline,
  handleApproval,
  handleRejection,
  getRun,
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

app.get("/api/runs/:id", (req, res) => {
  const run = getRun(req.params.id);
  if (!run) {
    return res.status(404).json({ error: "Run not found" });
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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`ForgeOS server running on port ${PORT}`);
});
