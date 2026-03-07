const https = require("https");
const http = require("http");

const USER_AGENT = "ForgeOS/1.0 (Build Platform; +https://forgeos.dev)";

async function webSearch(query) {
  try {
    const params = new URLSearchParams({ q: query, format: "json", no_html: "1", skip_disambig: "1" });
    const ddgUrl = `https://api.duckduckgo.com/?${params.toString()}`;
    const ddgResult = await fetchRaw(ddgUrl);
    const ddgData = JSON.parse(ddgResult);

    const results = [];
    let answer = "";

    if (ddgData.AbstractText) {
      answer = ddgData.AbstractText;
      if (ddgData.AbstractURL) {
        results.push({ title: ddgData.AbstractSource || "Source", url: ddgData.AbstractURL, snippet: ddgData.AbstractText });
      }
    }

    if (ddgData.Answer) {
      answer = answer || ddgData.Answer;
    }

    if (ddgData.RelatedTopics) {
      for (const topic of ddgData.RelatedTopics.slice(0, 8)) {
        if (topic.FirstURL && topic.Text) {
          results.push({ title: topic.Text.slice(0, 100), url: topic.FirstURL, snippet: topic.Text });
        }
        if (topic.Topics) {
          for (const sub of topic.Topics.slice(0, 3)) {
            if (sub.FirstURL && sub.Text) {
              results.push({ title: sub.Text.slice(0, 100), url: sub.FirstURL, snippet: sub.Text });
            }
          }
        }
      }
    }

    if (results.length === 0 && !answer) {
      const htmlResults = await scrapeSearch(query);
      if (htmlResults.length > 0) {
        results.push(...htmlResults);
        answer = htmlResults[0].snippet || "";
      }
    }

    return {
      query,
      answer: answer || "No direct answer found. See search results for relevant pages.",
      results: results.slice(0, 10),
    };
  } catch (err) {
    return { query, answer: `Search failed: ${err.message}`, results: [] };
  }
}

async function scrapeSearch(query) {
  try {
    const params = new URLSearchParams({ q: query });
    const url = `https://html.duckduckgo.com/html/?${params.toString()}`;
    const html = await fetchRaw(url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "text/html",
      },
    });

    const results = [];
    const resultBlocks = html.split(/class="result__body"/g).slice(1, 11);
    for (const block of resultBlocks) {
      const urlMatch = block.match(/href="([^"]+)"/);
      const titleMatch = block.match(/class="result__a"[^>]*>([^<]+)/);
      const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)(?:<\/a>|<\/td>)/);

      if (urlMatch) {
        let href = urlMatch[1];
        if (href.includes("uddg=")) {
          try {
            href = decodeURIComponent(href.split("uddg=")[1].split("&")[0]);
          } catch {}
        }
        const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, "").trim() : href;
        const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, "").trim() : "";
        results.push({ title, url: href, snippet });
      }
    }
    return results;
  } catch {
    return [];
  }
}

const BLOCKED_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "metadata.google.internal"]);
const PRIVATE_IP_PATTERNS = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^100\.(6[4-9]|[7-9]\d|1[0-2]\d)\./,
  /^fd[0-9a-f]{2}:/i,
  /^fe80:/i,
];

function isUrlSafe(urlStr) {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    const hostname = parsed.hostname.toLowerCase();
    if (BLOCKED_HOSTS.has(hostname)) return false;
    for (const pattern of PRIVATE_IP_PATTERNS) {
      if (pattern.test(hostname)) return false;
    }
    if (parsed.port && !["80", "443", ""].includes(parsed.port)) return false;
    return true;
  } catch {
    return false;
  }
}

async function fetchUrl(url, maxLength = 15000) {
  if (!isUrlSafe(url)) {
    return { url, content: "URL blocked: only public HTTP/HTTPS URLs are allowed.", contentType: "error" };
  }

  try {
    const raw = await fetchRaw(url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,text/plain,application/json",
      },
      maxRedirects: 5,
      validateRedirects: true,
    });

    const contentType = detectContentType(raw);

    if (contentType === "json") {
      try {
        const parsed = JSON.parse(raw);
        const text = JSON.stringify(parsed, null, 2);
        return { url, content: text.slice(0, maxLength), contentType: "json" };
      } catch {}
    }

    const text = htmlToText(raw);
    return { url, content: text.slice(0, maxLength), contentType: "text" };
  } catch (err) {
    return { url, content: `Failed to fetch: ${err.message}`, contentType: "error" };
  }
}

function detectContentType(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json";
  if (trimmed.startsWith("<")) return "html";
  return "text";
}

function htmlToText(html) {
  let text = html;
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, "");
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, "");
  text = text.replace(/<header[\s\S]*?<\/header>/gi, "");
  text = text.replace(/<aside[\s\S]*?<\/aside>/gi, "");

  text = text.replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, "\n## $1\n");
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n");
  text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "$1\n\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)");
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, "\n```\n$1\n```\n");

  text = text.replace(/<[^>]+>/g, "");
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.replace(/[ \t]+/g, " ");

  const lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 0);
  return lines.join("\n");
}

function fetchRaw(url, options = {}) {
  return new Promise((resolve, reject) => {
    const maxRedirects = options.maxRedirects || 3;
    const validateRedirects = options.validateRedirects || false;
    let redirectCount = 0;

    function doFetch(targetUrl) {
      const mod = targetUrl.startsWith("https") ? https : http;
      const req = mod.get(targetUrl, {
        headers: {
          "User-Agent": USER_AGENT,
          ...(options.headers || {}),
        },
        timeout: 10000,
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          redirectCount++;
          if (redirectCount > maxRedirects) {
            reject(new Error("Too many redirects"));
            return;
          }
          let next = res.headers.location;
          if (next.startsWith("/")) {
            const parsed = new URL(targetUrl);
            next = `${parsed.protocol}//${parsed.host}${next}`;
          }
          if (validateRedirects && !isUrlSafe(next)) {
            res.resume();
            reject(new Error("Redirect to blocked URL"));
            return;
          }
          res.resume();
          doFetch(next);
          return;
        }

        if (res.statusCode >= 400) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }

        const chunks = [];
        let totalSize = 0;
        const MAX_SIZE = 512 * 1024;
        res.on("data", (chunk) => {
          totalSize += chunk.length;
          if (totalSize <= MAX_SIZE) chunks.push(chunk);
        });
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        res.on("error", reject);
      });

      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out")); });
    }

    doFetch(url);
  });
}

module.exports = { webSearch, fetchUrl };
