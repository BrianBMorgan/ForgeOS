"use strict";

// ── Google Workspace Auth ─────────────────────────────────────────────────────
// Single-user OAuth for ForgeOS. Client id/secret live in the secrets vault.
// After the one-time consent flow, the refresh token goes into the vault too
// and is used to mint access tokens on demand. Access tokens are cached in
// memory for up to 55 minutes (Google issues them for 60).

const settingsManager = require("../../settings/manager");

const REDIRECT_URI_PATH = "/api/google/auth/callback";
const OAUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

// The scopes we request. Must be a subset of what the OAuth app has configured.
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/documents.readonly",
  "https://www.googleapis.com/auth/contacts",
];

let _cachedAccessToken = null;
let _cachedAccessTokenExpiresAt = 0;

function getBaseUrl(req) {
  // Use the incoming request to build the redirect URI so this works in both
  // local dev and production without hard-coding.
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "forge-os.ai";
  return `${proto}://${host}`;
}

async function getClientCredentials() {
  const clientId = (await settingsManager.getSecret("GOOGLE_CLIENT_ID")) || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = (await settingsManager.getSecret("GOOGLE_CLIENT_SECRET")) || process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Google OAuth not configured. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to Settings → Secrets Vault.");
  }
  return { clientId, clientSecret };
}

function buildConsentUrl({ clientId, redirectUri }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",       // required to get a refresh token
    prompt: "consent",             // force consent so refresh_token is always returned
    include_granted_scopes: "true",
  });
  return `${OAUTH_ENDPOINT}?${params.toString()}`;
}

async function exchangeCodeForTokens({ code, redirectUri }) {
  const { clientId, clientSecret } = await getClientCredentials();
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Token exchange failed: ${JSON.stringify(data).slice(0, 400)}`);
  if (!data.refresh_token) {
    throw new Error("No refresh_token in response. Revoke prior consent at https://myaccount.google.com/permissions and try again.");
  }
  return data;
}

async function refreshAccessToken() {
  const refreshToken = await settingsManager.getSecret("GOOGLE_REFRESH_TOKEN");
  if (!refreshToken) {
    throw new Error("Google not connected. Visit /api/google/auth/start to authorize.");
  }
  const { clientId, clientSecret } = await getClientCredentials();
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Access token refresh failed: ${JSON.stringify(data).slice(0, 400)}. Re-auth at /api/google/auth/start if this persists.`);
  }
  const expiresInSec = Number(data.expires_in || 3600);
  _cachedAccessToken = data.access_token;
  _cachedAccessTokenExpiresAt = Date.now() + Math.max(60, expiresInSec - 300) * 1000; // refresh 5 minutes early
  return _cachedAccessToken;
}

async function getAccessToken() {
  if (_cachedAccessToken && Date.now() < _cachedAccessTokenExpiresAt) {
    return _cachedAccessToken;
  }
  return refreshAccessToken();
}

async function googleFetch(url, options = {}) {
  const token = await getAccessToken();
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  // Retry once on 401 in case the token was just invalidated
  if (res.status === 401) {
    _cachedAccessToken = null;
    const freshToken = await getAccessToken();
    return fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${freshToken}`,
        ...(options.headers || {}),
      },
    });
  }
  return res;
}

// Parse JSON, throw with a useful message on failure.
async function jsonOrThrow(res, label) {
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data.error?.message || data.error_description || data.raw || JSON.stringify(data).slice(0, 400);
    throw new Error(`${label} failed (${res.status}): ${msg}`);
  }
  return data;
}

async function isConnected() {
  try {
    const refreshToken = await settingsManager.getSecret("GOOGLE_REFRESH_TOKEN");
    return Boolean(refreshToken);
  } catch {
    return false;
  }
}

async function disconnect() {
  await settingsManager.deleteSecret("GOOGLE_REFRESH_TOKEN");
  _cachedAccessToken = null;
  _cachedAccessTokenExpiresAt = 0;
}

module.exports = {
  SCOPES,
  REDIRECT_URI_PATH,
  getBaseUrl,
  getClientCredentials,
  buildConsentUrl,
  exchangeCodeForTokens,
  getAccessToken,
  googleFetch,
  jsonOrThrow,
  isConnected,
  disconnect,
};
