const express = require("express");
const compression = require("compression");
const cors = require("cors");
const multer = require("multer");
const { execFile, spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const i18n = require("./data/i18n");
const allBlogPosts = require("./data/blog-posts");

const app = express();
const PORT = process.env.PORT || 3000;
const DOWNLOAD_DIR = path.join(__dirname, "downloads");
const UPLOAD_DIR = path.join(__dirname, "uploads");
const BASE_URL = process.env.BASE_URL || "https://snapclip.pro";
const YTDLP_USER_AGENT = process.env.YTDLP_USER_AGENT || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

[DOWNLOAD_DIR, UPLOAD_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(compression({
  filter: (req, res) => {
    if (req.path && req.path.startsWith("/api/stream/")) return false;
    return compression.filter(req, res);
  },
}));
app.use(cors());
app.use(express.json());

// Language middleware
function langMiddleware(req, res, next) {
  if (req.path.startsWith("/vi/") || req.path === "/vi") {
    req.lang = "vi";
    req.langPrefix = "/vi";
  } else {
    req.lang = "en";
    req.langPrefix = "";
  }
  req.t = i18n[req.lang] || i18n.en;
  next();
}
app.use(langMiddleware);

// SEO: normalize trailing slashes to avoid duplicate URLs
// - Keep: "/" and "/vi/" (language root)
// - Redirect: "/vi" -> "/vi/"
// - Redirect: any other path ending with "/" -> same path without trailing slash
function trailingSlashNormalization(req, res, next) {
  if (req.method !== "GET" && req.method !== "HEAD") return next();

  const pathname = req.path;
  const querySuffix = req.url.slice(req.path.length); // includes leading "?" if present

  if (pathname === "/vi") {
    return res.redirect(301, "/vi/" + querySuffix);
  }

  if (pathname.length > 1 && pathname.endsWith("/") && pathname !== "/vi/") {
    const normalized = pathname.replace(/\/+$/, "");
    return res.redirect(301, normalized + querySuffix);
  }

  next();
}
app.use(trailingSlashNormalization);

function tplVars(req, extra) {
  const currentPath = req.path.replace(/^\/vi/, "") || "/";
  return {
    t: req.t,
    lang: req.lang,
    langPrefix: req.langPrefix,
    altLangPrefix: req.lang === "en" ? "/vi" : "",
    currentPath,
    BASE_URL,
    ...extra,
  };
}

const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 100 * 1024 * 1024 } });

// Helpers
const SUPPORTED_HOSTS = [
  "tiktok.com", "youtube.com", "youtu.be", "facebook.com", "fb.watch",
  "instagram.com", "bilibili.com", "b23.tv", "twitter.com", "x.com",
  "xiaohongshu.com", "xhslink.com",
  "douyin.com",
];

function isValidUrl(str) {
  try { const u = new URL(str); return ["http:", "https:"].includes(u.protocol); }
  catch { return false; }
}

function isSupportedPlatform(urlStr) {
  try { const u = new URL(urlStr); return SUPPORTED_HOSTS.some(h => u.hostname === h || u.hostname.endsWith("." + h)); }
  catch { return false; }
}

function isTikTokUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const host = u.hostname.toLowerCase();
    return host === "tiktok.com" || host.endsWith(".tiktok.com");
  } catch {
    return false;
  }
}

function isYouTubeUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const host = u.hostname.toLowerCase();
    return host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com");
  } catch {
    return false;
  }
}

function isFacebookUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const host = u.hostname.toLowerCase();
    return host === "facebook.com" || host.endsWith(".facebook.com") || host === "fb.watch" || host.endsWith(".fb.watch");
  } catch {
    return false;
  }
}

function isXiaohongshuUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const host = u.hostname.toLowerCase();
    return host === "xiaohongshu.com" || host.endsWith(".xiaohongshu.com")
      || host === "xhslink.com" || host.endsWith(".xhslink.com");
  } catch {
    return false;
  }
}

async function fetchJsonWithTimeout(url, { timeoutMs = 2500, headers = {} } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "accept": "application/json,text/plain,*/*",
        "user-agent": YTDLP_USER_AGENT,
        ...headers,
      },
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function fetchTextWithTimeout(url, { timeoutMs = 2500, headers = {} } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        "user-agent": YTDLP_USER_AGENT,
        ...headers,
      },
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function decodeHtml(text) {
  return String(text || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function extractMetaContent(html, attr, value) {
  const re = new RegExp(`<meta[^>]+${attr}=["']${value}["'][^>]+content=["']([^"']+)["'][^>]*>|<meta[^>]+content=["']([^"']+)["'][^>]+${attr}=["']${value}["'][^>]*>`, "i");
  const match = String(html || "").match(re);
  return decodeHtml((match && (match[1] || match[2])) || "").trim() || null;
}

function extractTitleTag(html) {
  const match = String(html || "").match(/<title[^>]*>([^<]+)<\/title>/i);
  return decodeHtml((match && match[1]) || "").trim() || null;
}

function buildPartialPayload({ title, thumbnail, uploader, platform }) {
  return {
    title: title || "Video",
    thumbnail: thumbnail || null,
    duration: null,
    uploader: uploader || "",
    platform,
    formats: [{ formatId: "best", ext: "mp4", resolution: "Best", quality: "best" }],
    partial: true,
  };
}

async function fetchTikTokOEmbed(url) {
  const oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
  const data = await fetchJsonWithTimeout(oembedUrl, { timeoutMs: 2500 });
  return buildPartialPayload({
    title: data.title || "Video",
    thumbnail: data.thumbnail_url || null,
    uploader: data.author_name || data.author_url || "",
    platform: "TikTok",
  });
}

async function fetchYouTubeOEmbed(url) {
  const oembedUrl = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`;
  const data = await fetchJsonWithTimeout(oembedUrl, { timeoutMs: 2500 });
  return buildPartialPayload({
    title: data.title || "Video",
    thumbnail: data.thumbnail_url || null,
    uploader: data.author_name || "",
    platform: "Youtube",
  });
}

async function fetchFacebookMeta(url) {
  const html = await fetchTextWithTimeout(url, { timeoutMs: 3000 });
  const title = extractMetaContent(html, "property", "og:title")
    || extractMetaContent(html, "name", "twitter:title")
    || extractTitleTag(html);
  const thumbnail = extractMetaContent(html, "property", "og:image")
    || extractMetaContent(html, "name", "twitter:image");
  if (!title && !thumbnail) throw new Error("Could not parse Facebook metadata");
  return buildPartialPayload({
    title,
    thumbnail,
    uploader: "",
    platform: "Facebook",
  });
}

function ytDlpPlatformArgs(urlStr) {
  try {
    const u = new URL(urlStr);
    const host = u.hostname.toLowerCase();
    // YouTube sometimes requires different clients; android is often more resilient.
    if (host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com")) {
      return ["--extractor-args", "youtube:player_client=android"];
    }
  } catch {
    // ignore
  }
  return [];
}

function autoDeleteFile(filePath, ms = 600000) {
  setTimeout(() => { try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {} }, ms);
}

// Douyin direct handler (bypasses yt-dlp for Douyin)
const { getDouyinInfo, downloadDouyinVideo, isDouyinUrl } = require("./douyin-handler");

// ===================== INFO CACHE (speed up repeated pastes) =====================
const INFO_CACHE_TTL_MS = parseInt(process.env.INFO_CACHE_TTL_MS || "600000", 10); // 10 min
const INFO_CACHE_STALE_MS = parseInt(process.env.INFO_CACHE_STALE_MS || String(24 * 60 * 60 * 1000), 10); // 24h
const infoCache = new Map();
const infoRefreshInFlight = new Map();

const YTDLP_FRAGMENT_CONCURRENCY = String(process.env.YTDLP_FRAGMENT_CONCURRENCY || "8");

function normalizeInfoCacheKey(urlStr) {
  try {
    const u = new URL(String(urlStr || "").trim());
    u.hash = "";
    const dropExact = new Set(["gclid", "fbclid", "igshid"]);
    for (const key of [...u.searchParams.keys()]) {
      if (key.startsWith("utm_") || dropExact.has(key)) u.searchParams.delete(key);
    }
    return u.toString();
  } catch {
    return String(urlStr || "").trim();
  }
}

function getCachedInfo(urlStr) {
  const key = normalizeInfoCacheKey(urlStr);
  const entry = infoCache.get(key);
  if (!entry) return null;
  const now = Date.now();
  if (entry.expiresAt > now) {
    return { data: entry.data, isStale: false, key };
  }
  if (entry.staleUntil > now) {
    return { data: entry.data, isStale: true, key };
  }
  infoCache.delete(key);
  return null;
}

function setCachedInfo(urlStr, data) {
  const key = normalizeInfoCacheKey(urlStr);
  const now = Date.now();
  infoCache.set(key, { expiresAt: now + INFO_CACHE_TTL_MS, staleUntil: now + INFO_CACHE_TTL_MS + INFO_CACHE_STALE_MS, data });
  return key;
}

function buildInfoPayload(info) {
  let formats = (info.formats || [])
    .filter(f => f.vcodec !== "none" && f.acodec !== "none" && f.url)
    .map(f => ({
      formatId: f.format_id,
      ext: f.ext,
      resolution: f.resolution || `${f.width || "?"}x${f.height || "?"}`,
      height: f.height || 0,
      filesize: f.filesize || f.filesize_approx || null,
      quality: f.format_note || f.quality || "",
    }));
  formats.sort((a, b) => b.height - a.height);
  const seen = new Set();
  formats = formats.filter(f => { if (seen.has(f.resolution)) return false; seen.add(f.resolution); return true; });
  formats = formats.map(({ height, ...r }) => r);
  return {
    title: info.title || "Video",
    thumbnail: info.thumbnail || null,
    duration: info.duration || null,
    uploader: info.uploader || info.channel || "",
    platform: info.extractor_key || info.extractor || "",
    formats: formats.length ? formats : [{ formatId: "best", ext: "mp4", resolution: "Best", quality: "best" }],
  };
}

function fetchInfoViaYtDlp(url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    execFile(
      "yt-dlp",
      ["--no-warnings", "--user-agent", YTDLP_USER_AGENT, "--dump-json", "--no-playlist", ...ytDlpPlatformArgs(url), url],
      { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        try {
          const info = JSON.parse(stdout);
          resolve(buildInfoPayload(info));
        } catch (e) {
          reject(e);
        }
      }
    );
  });
}

async function fetchFullInfo(url) {
  if (isDouyinUrl(url)) return getDouyinInfo(url);
  // XHS short links need extra time for redirect chain
  if (isXiaohongshuUrl(url)) return fetchInfoViaYtDlp(url, 60000);
  return fetchInfoViaYtDlp(url);
}

function refreshInfoInBackground(cacheKey, url) {
  if (infoRefreshInFlight.has(cacheKey)) return;
  const p = fetchFullInfo(url).then((payload) => {
    infoCache.set(cacheKey, {
      expiresAt: Date.now() + INFO_CACHE_TTL_MS,
      staleUntil: Date.now() + INFO_CACHE_TTL_MS + INFO_CACHE_STALE_MS,
      data: payload,
    });
  }).catch(() => {
    // keep stale cache if refresh fails
  }).finally(() => {
    infoRefreshInFlight.delete(cacheKey);
  });
  infoRefreshInFlight.set(cacheKey, p);
}

// ===================== CONCURRENCY LIMITER (protect server from OOM) =====================
const MAX_CONCURRENT_DOWNLOADS = parseInt(process.env.MAX_CONCURRENT_DOWNLOADS || "10", 10);
const MAX_QUEUE_SIZE = parseInt(process.env.MAX_QUEUE_SIZE || "50", 10);
const QUEUE_TIMEOUT_MS = parseInt(process.env.QUEUE_TIMEOUT_MS || "120000", 10); // 2min max wait in queue

let activeDownloads = 0;
const downloadQueue = [];

function acquireSlot() {
  return new Promise((resolve, reject) => {
    if (activeDownloads < MAX_CONCURRENT_DOWNLOADS) {
      activeDownloads++;
      return resolve();
    }
    if (downloadQueue.length >= MAX_QUEUE_SIZE) {
      return reject(new Error("Server is busy. Please try again in a moment."));
    }
    const timer = setTimeout(() => {
      const idx = downloadQueue.findIndex(e => e.resolve === resolve);
      if (idx !== -1) downloadQueue.splice(idx, 1);
      reject(new Error("Download queue timeout. Please try again."));
    }, QUEUE_TIMEOUT_MS);
    downloadQueue.push({ resolve, reject, timer });
  });
}

function releaseSlot() {
  if (downloadQueue.length > 0) {
    const next = downloadQueue.shift();
    clearTimeout(next.timer);
    next.resolve();
  } else {
    activeDownloads = Math.max(0, activeDownloads - 1);
  }
}

// ===================== DOWNLOAD PROGRESS TRACKING =====================
const downloadJobs = new Map();
const streamJobs = new Map();

function cleanupJob(jobId, delayMs = 120000) {
  setTimeout(() => downloadJobs.delete(jobId), delayMs);
}

function cleanupStreamJob(jobId, delayMs = 15 * 60 * 1000) {
  setTimeout(() => streamJobs.delete(jobId), delayMs);
}

app.get("/api/progress/:jobId", (req, res) => {
  const job = downloadJobs.get(req.params.jobId);
  if (!job) return res.json({ status: "unknown" });
  res.json(job);
});

// ===================== BLOG HELPERS =====================
function getBlogPosts(lang) {
  return allBlogPosts.filter(p => p.lang === lang);
}

// ===================== PAGE ROUTES (bilingual) =====================
function dualRoute(routePath, handler) {
  app.get(routePath, handler);
  app.get("/vi" + routePath, handler);
}

// Home
app.get("/", (req, res) => {
  const posts = getBlogPosts(req.lang);
  res.render("home", tplVars(req, {
    title: "SnapClip \u2013 Download Videos Without Watermark",
    description: "Free online tool to download videos from TikTok, YouTube, Facebook, Instagram, Bilibili, Twitter, Xiaohongshu, Douyin without watermark.",
    canonical: BASE_URL + "/",
    latestPosts: posts.slice(0, 3),
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: "SnapClip",
      operatingSystem: "Any",
      applicationCategory: "MultimediaApplication",
      url: BASE_URL + "/",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    },
  }));
});

app.get("/vi", (req, res) => {
  const posts = getBlogPosts(req.lang);
  res.render("home", tplVars(req, {
    title: "SnapClip \u2013 T\u1EA3i Video Kh\u00F4ng Watermark",
    description: "C\u00F4ng c\u1EE5 tr\u1EF1c tuy\u1EBFn mi\u1EC5n ph\u00ED t\u1EA3i video t\u1EEB TikTok, YouTube, Facebook, Instagram, Bilibili, Twitter, Xiaohongshu, Douyin kh\u00F4ng watermark.",
    canonical: BASE_URL + "/vi/",
    latestPosts: posts.slice(0, 3),
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: "SnapClip",
      operatingSystem: "Any",
      applicationCategory: "MultimediaApplication",
      url: BASE_URL + "/vi/",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      inLanguage: "vi",
    },
  }));
});

dualRoute("/tools", (req, res) => {
  res.render("tools", tplVars(req, {
    title: (req.t.navTools || "All Tools") + " \u2013 SnapClip",
    description: req.t.allToolsDesc || "Browse all free video download and conversion tools.",
    canonical: BASE_URL + req.langPrefix + "/tools",
  }));
});

// Platform downloaders
const platformRoutes = {
  "/tiktok-downloader": "tiktok",
  "/instagram-downloader": "instagram",
  "/facebook-video-downloader": "facebook",
  "/bilibili-video-downloader": "bilibili",
  "/twitter-video-downloader": "twitter",
  "/xiaohongshu-video-downloader": "xiaohongshu",
  "/douyin-video-downloader": "douyin",
};

// Common SEO aliases -> canonical landing pages
const platformAliasRedirects = {
  "/facebook-downloader": "/facebook-video-downloader",
  "/twitter-downloader": "/twitter-video-downloader",
  "/x-downloader": "/twitter-video-downloader",
  "/bilibili-downloader": "/bilibili-video-downloader",
  "/xiaohongshu-downloader": "/xiaohongshu-video-downloader",
  "/rednote-downloader": "/xiaohongshu-video-downloader",
  "/douyin-downloader": "/douyin-video-downloader",
};

Object.entries(platformAliasRedirects).forEach(([from, to]) => {
  dualRoute(from, (req, res) => res.redirect(301, req.langPrefix + to));
});

Object.entries(platformRoutes).forEach(([route, key]) => {
  dualRoute(route, (req, res) => {
    const p = req.t.platforms[key];
    res.render("downloader", tplVars(req, {
      title: p.title + " \u2013 SnapClip",
      description: p.description,
      canonical: BASE_URL + req.langPrefix + route,
      platform: p,
      faqSchema: p.faq,
      breadcrumbs: [
        { name: req.t.navHome || "Home", url: BASE_URL + req.langPrefix + "/" },
        { name: req.t.navTools, url: BASE_URL + req.langPrefix + "/tools" },
        { name: p.name },
      ],
    }));
  });
});

dualRoute("/youtube-downloader", (req, res) => {
  const ytFaq = [
    { q: req.t.ytFaq1Q, a: req.t.ytFaq1A },
    { q: req.t.ytFaq2Q, a: req.t.ytFaq2A.replace('{mp3Tab}', req.t.mp3Audio) },
    { q: req.t.ytFaq3Q, a: req.t.ytFaq3A },
    { q: req.t.ytFaq4Q, a: req.t.ytFaq4A },
  ];
  res.render("youtube-downloader", tplVars(req, {
    title: req.t.ytPageTitle + " \u2013 MP4 & MP3 \u2013 SnapClip",
    description: req.t.ytPageDesc,
    canonical: BASE_URL + req.langPrefix + "/youtube-downloader",
    faqSchema: ytFaq,
    breadcrumbs: [
      { name: req.t.navHome || "Home", url: BASE_URL + req.langPrefix + "/" },
      { name: req.t.navTools, url: BASE_URL + req.langPrefix + "/tools" },
      { name: "YouTube" },
    ],
  }));
});

dualRoute("/youtube-thumbnail-downloader", (req, res) => {
  res.render("thumbnail-downloader", tplVars(req, {
    title: req.t.thumbPageTitle + " \u2013 SnapClip",
    description: req.t.thumbPageDesc,
    canonical: BASE_URL + req.langPrefix + "/youtube-thumbnail-downloader",
    faqSchema: [{q:req.t.thumbFaq1Q,a:req.t.thumbFaq1A},{q:req.t.thumbFaq2Q,a:req.t.thumbFaq2A}],
    breadcrumbs: [
      { name: req.t.navHome || "Home", url: BASE_URL + req.langPrefix + "/" },
      { name: req.t.navTools, url: BASE_URL + req.langPrefix + "/tools" },
      { name: req.t.thumbnailTitle },
    ],
  }));
});

dualRoute("/mp4-to-mp3", (req, res) => {
  const pTitle = req.t.mp4ToMp3Title || "MP4 to MP3 Converter";
  res.render("converter", tplVars(req, {
    title: pTitle + " \u2013 SnapClip",
    description: req.t.mp4ToMp3Desc || "Convert MP4 video to MP3 audio. Paste a URL or upload a file.",
    canonical: BASE_URL + req.langPrefix + "/mp4-to-mp3",
    pageTitle: pTitle,
    pageDesc: req.t.mp4ToMp3Desc || "Convert any video to MP3 audio. Paste a video URL or upload a file.",
    faqSchema: [{q:req.t.converterFaq1Q,a:req.t.converterFaq1A},{q:req.t.converterFaq2Q,a:req.t.converterFaq2A},{q:req.t.converterFaq3Q,a:req.t.converterFaq3A}],
    breadcrumbs: [
      { name: req.t.navHome || "Home", url: BASE_URL + req.langPrefix + "/" },
      { name: req.t.navTools, url: BASE_URL + req.langPrefix + "/tools" },
      { name: pTitle },
    ],
  }));
});

dualRoute("/video-to-audio", (req, res) => {
  const pTitle = req.t.videoToAudioTitle || "Video to Audio Converter";
  res.render("converter", tplVars(req, {
    title: pTitle + " \u2013 SnapClip",
    description: req.t.videoToAudioDesc || "Extract audio from any video. Supports URL and file upload.",
    canonical: BASE_URL + req.langPrefix + "/video-to-audio",
    pageTitle: pTitle,
    pageDesc: req.t.videoToAudioDesc || "Extract audio from any video. Paste a URL or upload a video file.",
    faqSchema: [{q:req.t.converterFaq1Q,a:req.t.converterFaq1A},{q:req.t.converterFaq2Q,a:req.t.converterFaq2A},{q:req.t.converterFaq3Q,a:req.t.converterFaq3A}],
    breadcrumbs: [
      { name: req.t.navHome || "Home", url: BASE_URL + req.langPrefix + "/" },
      { name: req.t.navTools, url: BASE_URL + req.langPrefix + "/tools" },
      { name: pTitle },
    ],
  }));
});

// Redirect old subtitle page to tools
dualRoute("/subtitle-downloader", (req, res) => res.redirect(301, req.langPrefix + "/tools"));

dualRoute("/video-trimmer", (req, res) => {
  res.render("video-trimmer", tplVars(req, {
    title: req.t.trimmerPageTitle + " \u2013 SnapClip",
    description: req.t.trimmerPageDesc,
    canonical: BASE_URL + req.langPrefix + "/video-trimmer",
    faqSchema: [{q:req.t.trimFaq1Q,a:req.t.trimFaq1A},{q:req.t.trimFaq2Q,a:req.t.trimFaq2A},{q:req.t.trimFaq3Q,a:req.t.trimFaq3A}],
    breadcrumbs: [
      { name: req.t.navHome || "Home", url: BASE_URL + req.langPrefix + "/" },
      { name: req.t.navTools, url: BASE_URL + req.langPrefix + "/tools" },
      { name: req.t.trimmerTitle },
    ],
  }));
});

// Blog
dualRoute("/blog", (req, res) => {
  const posts = getBlogPosts(req.lang);
  res.render("blog-index", tplVars(req, {
    title: (req.t.navBlog || "Blog") + " \u2013 SnapClip",
    description: req.t.blogDesc || "Guides and tutorials on downloading videos from popular platforms.",
    canonical: BASE_URL + req.langPrefix + "/blog",
    posts,
  }));
});

dualRoute("/blog/:slug", (req, res) => {
  const posts = getBlogPosts(req.lang);
  const post = posts.find(p => p.slug === req.params.slug);
  if (!post) {
    const isVi = req.lang === 'vi';
    return res.status(404).render("legal", tplVars(req, {
      title: (isVi ? 'Kh\u00F4ng t\u00ECm th\u1EA5y b\u00E0i vi\u1EBFt' : 'Post Not Found') + ' \u2013 SnapClip',
      description: isVi ? 'B\u00E0i vi\u1EBFt b\u1EA1n t\u00ECm ki\u1EBFm kh\u00F4ng t\u1ED3n t\u1EA1i.' : 'The post you are looking for does not exist.',
      canonical: null,
      noindex: true,
      pageTitle: isVi ? '404 \u2013 Kh\u00F4ng t\u00ECm th\u1EA5y b\u00E0i vi\u1EBFt' : '404 \u2013 Post Not Found',
      content: isVi
        ? '<p>B\u00E0i vi\u1EBFt kh\u00F4ng t\u1ED3n t\u1EA1i.</p><p><a href="' + req.langPrefix + '/blog">Quay v\u1EC1 blog</a></p>'
        : '<p>Post not found.</p><p><a href="' + req.langPrefix + '/blog">Back to blog</a></p>',
    }));
  }
  const relatedPosts = posts.filter(p => p.slug !== post.slug).slice(0, 3);
  const canonicalUrl = BASE_URL + req.langPrefix + "/blog/" + post.slug;
  const parsedDate = new Date(post.date);
  const isoDate = isNaN(parsedDate) ? null : parsedDate.toISOString();
  res.render("blog/post", tplVars(req, {
    title: post.title + " \u2013 SnapClip",
    description: post.excerpt,
    canonical: canonicalUrl,
    post,
    relatedPosts,
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "BlogPosting",
      headline: post.title,
      description: post.excerpt,
      url: canonicalUrl,
      mainEntityOfPage: { "@type": "WebPage", "@id": canonicalUrl },
      datePublished: isoDate || undefined,
      dateModified: isoDate || undefined,
      author: { "@type": "Organization", name: "SnapClip" },
      publisher: {
        "@type": "Organization",
        name: "SnapClip",
        logo: { "@type": "ImageObject", url: BASE_URL + "/images/og-default.png" },
      },
      inLanguage: req.lang,
    },
  }));
});

// FAQ
dualRoute("/faq", (req, res) => {
  res.render("faq", tplVars(req, {
    title: (req.t.navFaq || "FAQ") + " \u2013 SnapClip",
    description: req.t.faqDesc || "Frequently asked questions about our video download tools.",
    canonical: BASE_URL + req.langPrefix + "/faq",
  }));
});

// Contact
dualRoute("/contact", (req, res) => {
  res.render("contact", tplVars(req, {
    title: (req.t.navContact || "Contact") + " \u2013 SnapClip",
    description: req.t.contactDesc || "Contact us for questions, bug reports, or DMCA requests.",
    canonical: BASE_URL + req.langPrefix + "/contact",
  }));
});

// Contact form submission
app.post("/api/contact", (req, res) => {
  const { name, email, subject, message } = req.body;
  if (!name || !email || !message) return res.status(400).json({ error: "All fields are required" });
  if (typeof name !== "string" || typeof email !== "string" || typeof message !== "string") return res.status(400).json({ error: "Invalid input" });
  if (name.length > 200 || email.length > 200 || message.length > 5000) return res.status(400).json({ error: "Input too long" });
  const contactDir = path.join(__dirname, "contact-messages");
  if (!fs.existsSync(contactDir)) fs.mkdirSync(contactDir, { recursive: true });
  const entry = { name: name.slice(0, 200), email: email.slice(0, 200), subject: String(subject || "general").slice(0, 50), message: message.slice(0, 5000), date: new Date().toISOString() };
  fs.writeFileSync(path.join(contactDir, Date.now() + ".json"), JSON.stringify(entry, null, 2));
  res.json({ ok: true });
});

// Legal pages
["privacy-policy", "terms-of-service", "disclaimer", "dmca"].forEach(page => {
  dualRoute("/" + page, (req, res) => {
    const data = req.t.legalPages[page];
    res.render("legal", tplVars(req, {
      title: data.title + " \u2013 SnapClip",
      description: data.title + " for SnapClip.",
      canonical: BASE_URL + req.langPrefix + "/" + page,
      pageTitle: data.title,
      content: data.content,
    }));
  });
});

// Sitemap
app.get("/sitemap.xml", (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const toW3C = (d) => { try { const dt = new Date(d); return isNaN(dt) ? today : dt.toISOString().slice(0, 10); } catch { return today; } };
  const corePages = [
    { path: "/", priority: "1.0", changefreq: "daily" },
    { path: "/tools", priority: "0.9", changefreq: "weekly" },
    { path: "/tiktok-downloader", priority: "0.8", changefreq: "weekly" },
    { path: "/youtube-downloader", priority: "0.8", changefreq: "weekly" },
    { path: "/instagram-downloader", priority: "0.8", changefreq: "weekly" },
    { path: "/facebook-video-downloader", priority: "0.8", changefreq: "weekly" },
    { path: "/bilibili-video-downloader", priority: "0.7", changefreq: "weekly" },
    { path: "/twitter-video-downloader", priority: "0.8", changefreq: "weekly" },
    { path: "/xiaohongshu-video-downloader", priority: "0.8", changefreq: "weekly" },
    { path: "/douyin-video-downloader", priority: "0.8", changefreq: "weekly" },
    { path: "/youtube-thumbnail-downloader", priority: "0.7", changefreq: "weekly" },
    { path: "/mp4-to-mp3", priority: "0.7", changefreq: "weekly" },
    { path: "/video-to-audio", priority: "0.7", changefreq: "weekly" },
    { path: "/video-trimmer", priority: "0.7", changefreq: "weekly" },
    { path: "/blog", priority: "0.8", changefreq: "daily" },
    { path: "/faq", priority: "0.6", changefreq: "monthly" },
    { path: "/contact", priority: "0.5", changefreq: "monthly" },
    { path: "/privacy-policy", priority: "0.3", changefreq: "yearly" },
    { path: "/terms-of-service", priority: "0.3", changefreq: "yearly" },
    { path: "/disclaimer", priority: "0.3", changefreq: "yearly" },
    { path: "/dmca", priority: "0.3", changefreq: "yearly" },
  ];
  const enPosts = getBlogPosts("en");
  const viPosts = getBlogPosts("vi");

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n';

  corePages.forEach(pg => {
    const enUrl = BASE_URL + pg.path;
    const viUrl = BASE_URL + "/vi" + pg.path;
    xml += `  <url><loc>${enUrl}</loc><lastmod>${today}</lastmod><changefreq>${pg.changefreq}</changefreq><priority>${pg.priority}</priority><xhtml:link rel="alternate" hreflang="en" href="${enUrl}"/><xhtml:link rel="alternate" hreflang="vi" href="${viUrl}"/><xhtml:link rel="alternate" hreflang="x-default" href="${enUrl}"/></url>\n`;
    xml += `  <url><loc>${viUrl}</loc><lastmod>${today}</lastmod><changefreq>${pg.changefreq}</changefreq><priority>${pg.priority}</priority><xhtml:link rel="alternate" hreflang="en" href="${enUrl}"/><xhtml:link rel="alternate" hreflang="vi" href="${viUrl}"/><xhtml:link rel="alternate" hreflang="x-default" href="${enUrl}"/></url>\n`;
  });

  enPosts.forEach(p => {
    const enUrl = BASE_URL + "/blog/" + p.slug;
    const viUrl = BASE_URL + "/vi/blog/" + p.slug;
    xml += `  <url><loc>${enUrl}</loc><lastmod>${toW3C(p.date)}</lastmod><changefreq>monthly</changefreq><priority>0.6</priority><xhtml:link rel="alternate" hreflang="en" href="${enUrl}"/><xhtml:link rel="alternate" hreflang="vi" href="${viUrl}"/><xhtml:link rel="alternate" hreflang="x-default" href="${enUrl}"/></url>\n`;
  });

  viPosts.forEach(p => {
    const viUrl = BASE_URL + "/vi/blog/" + p.slug;
    const enUrl = BASE_URL + "/blog/" + p.slug;
    xml += `  <url><loc>${viUrl}</loc><lastmod>${toW3C(p.date)}</lastmod><changefreq>monthly</changefreq><priority>0.6</priority><xhtml:link rel="alternate" hreflang="en" href="${enUrl}"/><xhtml:link rel="alternate" hreflang="vi" href="${viUrl}"/><xhtml:link rel="alternate" hreflang="x-default" href="${enUrl}"/></url>\n`;
  });

  xml += "</urlset>";
  res.set("Content-Type", "application/xml");
  res.send(xml);
});

// Static files (after routes so routes take priority)
app.use(express.static(path.join(__dirname, "public"), {
  maxAge: process.env.STATIC_MAX_AGE || "6h",
}));

// ===================== API ROUTES =====================

// Warm-up endpoint (helps reduce Render cold-start impact)
app.get("/api/ping", (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// Server load stats (for monitoring)
app.get("/api/stats", (req, res) => {
  res.json({
    activeDownloads,
    queuedDownloads: downloadQueue.length,
    maxConcurrent: MAX_CONCURRENT_DOWNLOADS,
    maxQueue: MAX_QUEUE_SIZE,
    uptime: Math.round(process.uptime()),
    memMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
  });
});

// ===================== STREAMING DOWNLOADS (MP4) =====================
// Safer approach for multi-platform: add new endpoints and keep old file-based flow as fallback.
app.post("/api/download-stream", (req, res) => {
  const { url, formatId } = req.body;
  if (!url || !isValidUrl(url)) return res.status(400).json({ error: "Invalid URL" });
  if (!isSupportedPlatform(url)) return res.status(400).json({ error: "Unsupported platform" });

  // Douyin: keep existing file-based approach for now (streaming not implemented)
  if (isDouyinUrl(url)) return res.status(400).json({ error: "Streaming is not available for this platform yet." });

  const jobId = uuidv4();
  streamJobs.set(jobId, {
    mode: "mp4",
    url,
    formatId: formatId || "best",
    started: false,
    createdAt: Date.now(),
  });

  downloadJobs.set(jobId, { status: "downloading", percent: 0, speed: "", eta: "" });
  cleanupStreamJob(jobId);

  res.json({ jobId, streamUrl: `/api/stream/${jobId}`, filename: "video.mp4" });
});

app.get("/api/stream/:jobId", async (req, res) => {
  const jobId = req.params.jobId;
  const job = streamJobs.get(jobId);
  if (!job) return res.status(404).send("Stream job not found or expired");
  if (job.started) return res.status(409).send("Stream already started");
  job.started = true;

  try { await acquireSlot(); } catch (e) {
    downloadJobs.set(jobId, { status: "error", percent: 0, error: e.message });
    cleanupJob(jobId); streamJobs.delete(jobId);
    return res.status(503).send(e.message);
  }

  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${job.mode === "mp4" ? "video.mp4" : "file"}"`);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");

  const safeFormat = String(job.formatId || "best").replace(/[^a-zA-Z0-9+_-]/g, "");
  const args = [
    "--no-warnings",
    "--user-agent",
    YTDLP_USER_AGENT,
    "--no-playlist",
    "--newline",
    "-N",
    YTDLP_FRAGMENT_CONCURRENCY,
    "-o",
    "-",
  ];

  if (safeFormat && safeFormat !== "best") {
    // Our /api/info only exposes formats that already have audio+video.
    args.push("-f", safeFormat);
  } else {
    // Prefer progressive A/V formats to keep streaming reliable.
    args.push("-f", "best[ext=mp4][acodec!=none][vcodec!=none]/best[acodec!=none][vcodec!=none]/best");
  }

  args.push(...ytDlpPlatformArgs(job.url));
  args.push(job.url);

  const proc = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
  const killTimer = setTimeout(() => {
    try { proc.kill("SIGKILL"); } catch {}
  }, 10 * 60 * 1000);

  let stderrBuf = "";
  let stderrAll = "";
  proc.stderr.on("data", (chunk) => {
    const s = chunk.toString();
    stderrBuf += s;
    stderrAll += s;
    const lines = stderrBuf.split(/\r?\n/);
    stderrBuf = lines.pop();
    for (const line of lines) {
      const m = line.match(/(\d+\.?\d*)%/);
      if (m) {
        const st = downloadJobs.get(jobId);
        if (st) {
          st.percent = parseFloat(m[1]);
          const sp = line.match(/at\s+([\d.]+\s*\S+\/s)/);
          const et = line.match(/ETA\s+(\S+)/);
          if (sp) st.speed = sp[1];
          if (et) st.eta = et[1];
        }
      }
    }
  });

  res.on("close", () => {
    clearTimeout(killTimer);
    try { proc.kill("SIGKILL"); } catch {}
  });

  proc.on("close", (code) => {
    clearTimeout(killTimer);
    releaseSlot();
    if (code !== 0) {
      const errMsg = String(stderrAll || "").trim().slice(-800);
      downloadJobs.set(jobId, { status: "error", percent: 0, error: errMsg || "yt-dlp failed" });
      cleanupJob(jobId);
      streamJobs.delete(jobId);
      return;
    }
    downloadJobs.set(jobId, { status: "done", percent: 100, filename: "video.mp4" });
    cleanupJob(jobId);
    streamJobs.delete(jobId);
  });

  proc.stdout.on("error", () => {
    try { res.destroy(); } catch {}
  });
  proc.stdout.pipe(res);
});

// Get video info
app.post("/api/info", async (req, res) => {
  const { url } = req.body;
  if (!url || !isValidUrl(url)) return res.status(400).json({ error: "Invalid URL" });
  if (!isSupportedPlatform(url)) return res.status(400).json({ error: "Unsupported platform" });

  const cached = getCachedInfo(url);
  if (cached) {
    if (cached.isStale) refreshInfoInBackground(cached.key, url);
    return res.json(cached.data);
  }

  if (isDouyinUrl(url)) {
    try {
      const info = await getDouyinInfo(url);
      setCachedInfo(url, info);
      return res.json(info);
    } catch (err) {
      console.error("[Douyin info]", err.message);
      return res.status(500).json({ error: "Cannot fetch Douyin video info. Please check the URL." });
    }
  }

  // TikTok: respond quickly using oEmbed and refresh full info in background.
  if (isTikTokUrl(url)) {
    try {
      const payload = await fetchTikTokOEmbed(url);
      const cacheKey = setCachedInfo(url, payload);
      refreshInfoInBackground(cacheKey, url);
      return res.json(payload);
    } catch (err) {
      // Fall back to yt-dlp if oEmbed fails (rate-limit, network, etc.)
      console.error("[TikTok oEmbed]", err && err.message ? err.message : err);
    }
  }

  if (isYouTubeUrl(url)) {
    try {
      const payload = await fetchYouTubeOEmbed(url);
      const cacheKey = setCachedInfo(url, payload);
      refreshInfoInBackground(cacheKey, url);
      return res.json(payload);
    } catch (err) {
      console.error("[YouTube oEmbed]", err && err.message ? err.message : err);
    }
  }

  if (isFacebookUrl(url)) {
    try {
      const payload = await fetchFacebookMeta(url);
      const cacheKey = setCachedInfo(url, payload);
      refreshInfoInBackground(cacheKey, url);
      return res.json(payload);
    } catch (err) {
      console.error("[Facebook meta]", err && err.message ? err.message : err);
    }
  }

  try {
    const payload = await fetchFullInfo(url);
    setCachedInfo(url, payload);
    return res.json(payload);
  } catch (err) {
    console.error("[yt-dlp info]", err && err.message ? err.message : err);
    return res.status(500).json({ error: "Cannot fetch video info. Check URL." });
  }
});

// Download video (MP4)
app.post("/api/download", (req, res) => {
  const { url, formatId } = req.body;
  if (!url || !isValidUrl(url)) return res.status(400).json({ error: "Invalid URL" });
  if (!isSupportedPlatform(url)) return res.status(400).json({ error: "Unsupported platform" });

  // Douyin: use direct handler
  if (isDouyinUrl(url)) {
    const fileId = uuidv4();
    const jobId = uuidv4();
    downloadJobs.set(jobId, { status: "downloading", percent: 0, speed: "", eta: "" });
    res.json({ jobId });
    (async () => {
      try {
        const info = await getDouyinInfo(url);
        const videoUrl = formatId === "wm" ? info.videoUrlWm : info.videoUrl;
        const destPath = path.join(DOWNLOAD_DIR, `${fileId}.mp4`);
        await downloadDouyinVideo(videoUrl, destPath, (pct) => {
          const job = downloadJobs.get(jobId);
          if (job) job.percent = pct;
        });
        downloadJobs.set(jobId, { status: "done", percent: 100, downloadUrl: `/api/file/${fileId}.mp4`, filename: `douyin_${info.videoId}.mp4` });
        autoDeleteFile(destPath);
        cleanupJob(jobId);
      } catch (err) {
        console.error("[Douyin download]", err.message);
        downloadJobs.set(jobId, { status: "error", percent: 0 });
        cleanupJob(jobId);
      }
    })();
    return;
  }

  const fileId = uuidv4();
  const jobId = uuidv4();
  const outTpl = path.join(DOWNLOAD_DIR, `${fileId}.%(ext)s`);
  const args = ["--no-warnings", "--user-agent", YTDLP_USER_AGENT, "--no-playlist", "--newline", "-N", YTDLP_FRAGMENT_CONCURRENCY, "-o", outTpl, "--merge-output-format", "mp4"];
  if (formatId && formatId !== "best") {
    const safeFormat = String(formatId).replace(/[^a-zA-Z0-9+_-]/g, "");
    args.push("-f", `${safeFormat}+bestaudio/best`);
  } else {
    // Prefer progressive A/V where available, else merge bestvideo+bestaudio, else any best.
    args.push("-f", "best[ext=mp4][acodec!=none][vcodec!=none]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best");
  }
  args.push(...ytDlpPlatformArgs(url));
  args.push(url);

  downloadJobs.set(jobId, { status: "queued", percent: 0, speed: "", eta: "" });
  res.json({ jobId });

  (async () => {
    try { await acquireSlot(); } catch (e) {
      downloadJobs.set(jobId, { status: "error", percent: 0, error: e.message });
      cleanupJob(jobId); return;
    }
    downloadJobs.set(jobId, { status: "downloading", percent: 0, speed: "", eta: "" });

    const proc = spawn("yt-dlp", args);
    const killTimer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch {}
    }, 10 * 60 * 1000);
    let stderrBuf = "";
    let stderrAll = "";
    proc.stderr.on("data", (chunk) => {
      const s = chunk.toString();
      stderrBuf += s;
      stderrAll += s;
      const lines = stderrBuf.split(/\r?\n/);
      stderrBuf = lines.pop();
      for (const line of lines) {
        const m = line.match(/(\d+\.?\d*)%/);
        if (m) {
          const job = downloadJobs.get(jobId);
          if (job) {
            job.percent = parseFloat(m[1]);
            const sp = line.match(/at\s+([\d.]+\s*\S+\/s)/);
            const et = line.match(/ETA\s+(\S+)/);
            if (sp) job.speed = sp[1];
            if (et) job.eta = et[1];
          }
        }
      }
    });
    proc.on("close", (code) => {
      clearTimeout(killTimer);
      releaseSlot();
      if (code !== 0) {
        const errMsg = String(stderrAll || "").trim().slice(-800);
        downloadJobs.set(jobId, { status: "error", percent: 0, error: errMsg || "yt-dlp failed" });
        cleanupJob(jobId);
        return;
      }
      const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.startsWith(fileId));
      if (!files.length) {
        downloadJobs.set(jobId, { status: "error", percent: 0, error: "No output file generated" });
        cleanupJob(jobId);
        return;
      }
      const filePath = path.join(DOWNLOAD_DIR, files[0]);
      const ext = path.extname(files[0]);
      downloadJobs.set(jobId, { status: "done", percent: 100, downloadUrl: `/api/file/${fileId}${ext}`, filename: `video${ext}` });
      autoDeleteFile(filePath);
      cleanupJob(jobId);
    });
  })();
});

// Download MP3 (audio extraction)
app.post("/api/download-mp3", (req, res) => {
  const { url } = req.body;
  if (!url || !isValidUrl(url)) return res.status(400).json({ error: "Invalid URL" });
  if (!isSupportedPlatform(url)) return res.status(400).json({ error: "Unsupported platform" });

  const fileId = uuidv4();
  const jobId = uuidv4();
  const outTpl = path.join(DOWNLOAD_DIR, `${fileId}.%(ext)s`);
  const args = ["--no-warnings", "--user-agent", YTDLP_USER_AGENT, "--no-playlist", "--newline", "-N", YTDLP_FRAGMENT_CONCURRENCY, "-o", outTpl, "-x", "--audio-format", "mp3", ...ytDlpPlatformArgs(url), url];

  downloadJobs.set(jobId, { status: "queued", percent: 0, speed: "", eta: "" });
  res.json({ jobId });

  (async () => {
    try { await acquireSlot(); } catch (e) {
      downloadJobs.set(jobId, { status: "error", percent: 0, error: e.message });
      cleanupJob(jobId); return;
    }
    downloadJobs.set(jobId, { status: "downloading", percent: 0, speed: "", eta: "" });

    const proc = spawn("yt-dlp", args);
    const killTimer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch {}
    }, 10 * 60 * 1000);
    let stderrBuf = "";
    let stderrAll = "";
    proc.stderr.on("data", (chunk) => {
      const s = chunk.toString();
      stderrBuf += s;
      stderrAll += s;
      const lines = stderrBuf.split(/\r?\n/);
      stderrBuf = lines.pop();
      for (const line of lines) {
        const m = line.match(/(\d+\.?\d*)%/);
        if (m) {
          const job = downloadJobs.get(jobId);
          if (job) {
            job.percent = parseFloat(m[1]);
            const sp = line.match(/at\s+([\d.]+\s*\S+\/s)/);
            const et = line.match(/ETA\s+(\S+)/);
            if (sp) job.speed = sp[1];
            if (et) job.eta = et[1];
          }
        }
      }
    });
    proc.on("close", (code) => {
      clearTimeout(killTimer);
      releaseSlot();
      if (code !== 0) {
        const errMsg = String(stderrAll || "").trim().slice(-800);
        downloadJobs.set(jobId, { status: "error", percent: 0, error: errMsg || "yt-dlp failed" });
        cleanupJob(jobId);
        return;
      }
      const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.startsWith(fileId));
      if (!files.length) {
        downloadJobs.set(jobId, { status: "error", percent: 0 });
        cleanupJob(jobId);
        return;
      }
      const filePath = path.join(DOWNLOAD_DIR, files[0]);
      const ext = path.extname(files[0]);
      downloadJobs.set(jobId, { status: "done", percent: 100, downloadUrl: `/api/file/${fileId}${ext}`, filename: `audio${ext}` });
      autoDeleteFile(filePath);
      cleanupJob(jobId);
    });
  })();
});

// Thumbnail fetch
app.post("/api/thumbnail", (req, res) => {
  const { url } = req.body;
  if (!url || !isValidUrl(url)) return res.status(400).json({ error: "Invalid URL" });

  execFile("yt-dlp", ["--no-warnings", "--dump-json", "--no-playlist", url],
    { timeout: 20000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
    if (err) return res.status(500).json({ error: "Cannot fetch video info" });
    try {
      const info = JSON.parse(stdout);
      const thumb = info.thumbnail || (info.thumbnails && info.thumbnails.length ? info.thumbnails[info.thumbnails.length - 1].url : null);
      if (!thumb) return res.status(404).json({ error: "No thumbnail found" });
      res.json({ thumbnail: thumb, title: info.title || "" });
    } catch { res.status(500).json({ error: "Failed to parse info" }); }
  });
});

// File upload: convert to MP3
app.post("/api/convert", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const inputPath = req.file.path;
  const fileId = uuidv4();
  const outputPath = path.join(DOWNLOAD_DIR, `${fileId}.mp3`);

  execFile("ffmpeg", ["-i", inputPath, "-vn", "-ab", "192k", "-y", outputPath],
    { timeout: 120000 }, (err) => {
    try { fs.unlinkSync(inputPath); } catch {}
    if (err) return res.status(500).json({ error: "Conversion failed. Make sure ffmpeg is installed." });
    res.json({ downloadUrl: `/api/file/${fileId}.mp3`, filename: "audio.mp3" });
    autoDeleteFile(outputPath);
  });
});

// File upload: trim video
app.post("/api/trim", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const { start, end } = req.body;
  if (!start || !end) { try { fs.unlinkSync(req.file.path); } catch {} return res.status(400).json({ error: "Start and end time required" }); }
  const timeRe = /^\d{1,2}:\d{2}(:\d{2})?$/;
  if (!timeRe.test(start) || !timeRe.test(end)) { try { fs.unlinkSync(req.file.path); } catch {} return res.status(400).json({ error: "Invalid time format. Use HH:MM:SS" }); }

  const inputPath = req.file.path;
  const fileId = uuidv4();
  const outputPath = path.join(DOWNLOAD_DIR, `${fileId}.mp4`);

  execFile("ffmpeg", ["-i", inputPath, "-ss", start, "-to", end, "-c", "copy", "-y", outputPath],
    { timeout: 120000 }, (err) => {
    try { fs.unlinkSync(inputPath); } catch {}
    if (err) return res.status(500).json({ error: "Trim failed. Make sure ffmpeg is installed." });
    res.json({ downloadUrl: `/api/file/${fileId}.mp4`, filename: "trimmed.mp4" });
    autoDeleteFile(outputPath);
  });
});

// Serve downloaded files
app.get("/api/file/:filename", (req, res) => {
  const filename = path.basename(req.params.filename);
  if (filename.includes("..") || filename.includes("/") || filename.includes("\\"))
    return res.status(400).json({ error: "Invalid filename" });
  const filePath = path.join(DOWNLOAD_DIR, filename);
  if (!filePath.startsWith(DOWNLOAD_DIR)) return res.status(400).json({ error: "Invalid path" });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found or expired" });
  const ext = path.extname(filename);
  const names = { ".mp4": "video.mp4", ".mp3": "audio.mp3" };
  res.download(filePath, names[ext] || "file" + ext);
});

// 404 handler
app.use((req, res) => {
  const isVi = req.lang === 'vi';
  res.status(404).render("legal", tplVars(req, {
    title: (isVi ? 'Kh\u00F4ng t\u00ECm th\u1EA5y trang' : 'Page Not Found') + ' \u2013 SnapClip',
    description: isVi ? 'Trang b\u1EA1n t\u00ECm ki\u1EBFm kh\u00F4ng t\u1ED3n t\u1EA1i.' : 'The page you are looking for does not exist.',
    canonical: null,
    noindex: true,
    pageTitle: isVi ? '404 \u2013 Kh\u00F4ng t\u00ECm th\u1EA5y trang' : '404 \u2013 Page Not Found',
    content: isVi
      ? '<p>Trang b\u1EA1n t\u00ECm ki\u1EBFm kh\u00F4ng t\u1ED3n t\u1EA1i.</p><p><a href="' + req.langPrefix + '/"\u003EQuay v\u1EC1 trang ch\u1EE7</a></p>'
      : '<p>The page you are looking for does not exist.</p><p><a href="' + req.langPrefix + '/"\u003EGo back to home page</a></p>',
  }));
});

// ===================== START =====================
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
