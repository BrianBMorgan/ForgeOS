"use strict";

const crypto = require("crypto");

const ALLOWED_EMAILS = new Set(
  (process.env.ALLOWED_EMAILS || "brian@sandbox-xm.com")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);

const SESSION_SECRET = process.env.SESSION_SECRET || "forgeos-dev-secret-change-me";
const COOKIE_NAME = "fos_session";
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

function signToken(email) {
  const payload = Buffer.from(JSON.stringify({ email, ts: Date.now() })).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== "string") return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString());
  } catch {
    return null;
  }
}

function getSessionEmail(req) {
  const raw = req.cookies?.[COOKIE_NAME];
  if (!raw) return null;
  const data = verifyToken(req.cookies[COOKIE_NAME]);
  if (!data) return null;
  return data.email?.toLowerCase() || null;
}

function gateHtml(error = "") {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ForgeOS — Access</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0a0c10;
      color: #e8eaf0;
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .card {
      background: #13161e;
      border: 1px solid #1e2230;
      border-radius: 12px;
      padding: 48px 40px;
      width: 100%;
      max-width: 400px;
      text-align: center;
    }
    .logo {
      font-size: 1.5rem;
      font-weight: 800;
      letter-spacing: -0.5px;
      margin-bottom: 8px;
      background: linear-gradient(135deg, #6c63ff, #00d4aa);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    .subtitle {
      color: #7a8099;
      font-size: 0.875rem;
      margin-bottom: 32px;
    }
    input[type="email"] {
      width: 100%;
      background: #0d0f14;
      border: 1px solid #2a2f3e;
      border-radius: 8px;
      color: #e8eaf0;
      font-size: 1rem;
      padding: 12px 16px;
      outline: none;
      transition: border-color 0.2s;
      margin-bottom: 12px;
    }
    input[type="email"]:focus { border-color: #6c63ff; }
    input[type="email"]::placeholder { color: #7a8099; }
    button {
      width: 100%;
      background: linear-gradient(135deg, #6c63ff, #8b5cf6);
      border: none;
      border-radius: 8px;
      color: #fff;
      font-size: 1rem;
      font-weight: 600;
      padding: 12px;
      cursor: pointer;
      transition: opacity 0.2s;
    }
    button:hover { opacity: 0.9; }
    .error {
      background: rgba(255,92,92,0.1);
      border: 1px solid rgba(255,92,92,0.3);
      color: #ff5c5c;
      border-radius: 8px;
      padding: 10px 14px;
      font-size: 0.85rem;
      margin-bottom: 16px;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">FORGE OS</div>
    <div class="subtitle">Enter your email to continue</div>
    ${error ? `<div class="error">${error}</div>` : ""}
    <form method="POST" action="/__auth/login">
      <input type="email" name="email" placeholder="you@example.com" required autofocus />
      <button type="submit">Continue</button>
    </form>
  </div>
</body>
</html>`;
}

function mountGate(app) {
  const cookieParser = require("cookie-parser");
  const express = require("express");
  app.use(cookieParser());

  app.post("/__auth/login", express.urlencoded({ extended: false }), (req, res) => {
    const email = (req.body.email || "").trim().toLowerCase();
    if (!ALLOWED_EMAILS.has(email)) {
      return res.status(403).send(gateHtml("Access denied. That email is not authorized."));
    }
    const token = signToken(email);
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: COOKIE_MAX_AGE,
    });
    res.redirect("/");
  });

  app.get("/__auth/logout", (req, res) => {
    res.clearCookie(COOKIE_NAME);
    res.redirect("/");
  });

  app.use((req, res, next) => {
    if (
      req.path === "/health" ||
      req.path.startsWith("/__auth/") ||
      req.path.startsWith("/apps/")
    ) {
      return next();
    }
    const email = getSessionEmail(req);
    if (email && ALLOWED_EMAILS.has(email)) return next();
    return res.status(401).send(gateHtml());
  });
}

module.exports = { mountGate };