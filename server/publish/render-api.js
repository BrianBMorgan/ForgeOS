"use strict";

const RENDER_API = "https://api.render.com/v1";
const RENDER_API_KEY = process.env.RENDER_API_KEY;
const RENDER_OWNER_ID = process.env.RENDER_OWNER_ID;

async function renderFetch(path, options = {}) {
  const res = await fetch(`${RENDER_API}${path}`, {
    ...options,
    headers: {
      "Authorization": `Bearer ${RENDER_API_KEY}`,
      "Accept": "application/json",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Render API error ${res.status}: ${text}`);
  }
  return res.json();
}

async function createService({ slug, repoPath, branch, envVars = {}, startCommand = "node server.js", buildCommand = null }) {
  const envVarList = Object.entries(envVars).map(([key, value]) => ({ key, value }));
  const body = {
    type: "web_service",
    name: `forgeos-${slug}`,
    ownerId: RENDER_OWNER_ID,
    repo: `https://github.com/${repoPath}`,
    branch,
    autoDeploy: "yes",
    serviceDetails: {
      env: "node",
      buildCommand: buildCommand || "npm install",
      startCommand: startCommand || "node server.js",
      plan: "starter",
      region: "oregon",
      envVars: envVarList,
    },
  };
  const result = await renderFetch("/services", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return {
    serviceId: result.service?.id,
    serviceUrl: `https://${result.service?.slug}.onrender.com`,
    name: result.service?.name,
  };
}

async function updateServiceEnv(serviceId, envVars = {}) {
  const envVarList = Object.entries(envVars).map(([key, value]) => ({ key, value }));
  return renderFetch(`/services/${serviceId}/env-vars`, {
    method: "PUT",
    body: JSON.stringify(envVarList),
  });
}

async function redeployService(serviceId) {
  return renderFetch(`/services/${serviceId}/deploys`, {
    method: "POST",
    body: JSON.stringify({ clearCache: "do_not_clear" }),
  });
}

async function getServiceStatus(serviceId) {
  const result = await renderFetch(`/services/${serviceId}`);
  return {
    status: result.service?.suspended === "suspended" ? "suspended" : "active",
    url: `https://${result.service?.slug}.onrender.com`,
    state: result.service?.serviceDetails?.env,
  };
}

async function deleteService(serviceId) {
  const res = await fetch(`${RENDER_API}/services/${serviceId}`, {
    method: "DELETE",
    headers: {
      "Authorization": `Bearer ${RENDER_API_KEY}`,
      "Accept": "application/json",
    },
  });
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(`Render API error ${res.status}: ${text}`);
  }
  return true;
}

async function listServices() {
  const result = await renderFetch(`/services?ownerId=${RENDER_OWNER_ID}&limit=100`);
  return (result || [])
    .filter(item => item.service?.name?.startsWith("forgeos-"))
    .map(item => ({
      serviceId: item.service.id,
      name: item.service.name,
      slug: item.service.name.replace("forgeos-", ""),
      url: `https://${item.service.slug}.onrender.com`,
    }));
}

module.exports = {
  pushProjectToGitHub,
  pushToAppBranch,
  verifyRepoAccess,
};