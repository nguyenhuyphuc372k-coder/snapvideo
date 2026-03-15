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

[DOWNLOAD_DIR, UPLOAD_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(compression());
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

function autoDeleteFile(filePath, ms = 600000) {
  setTimeout(() => { try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {} }, ms);
}

// Douyin direct handler (bypasses yt-dlp for Douyin)
const { getDouyinInfo, downloadDouyinVideo, isDouyinUrl } = require("./douyin-handler");

// ===================== INFO CACHE (speed up repeated pastes) =====================
const INFO_CACHE_TTL_MS = parseInt(process.env.INFO_CACHE_TTL_MS || "600000", 10); // 10 min
const infoCache = new Map();

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
  if (entry.expiresAt <= Date.now()) {
    infoCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCachedInfo(urlStr, data) {
  const key = normalizeInfoCacheKey(urlStr);
  infoCache.set(key, { expiresAt: Date.now() + INFO_CACHE_TTL_MS, data });
}

// ===================== DOWNLOAD PROGRESS TRACKING =====================
const downloadJobs = new Map();

function cleanupJob(jobId, delayMs = 120000) {
  setTimeout(() => downloadJobs.delete(jobId), delayMs);
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
  }));
});

app.get("/vi", (req, res) => {
  const posts = getBlogPosts(req.lang);
  res.render("home", tplVars(req, {
    title: "SnapClip \u2013 T\u1EA3i Video Kh\u00F4ng Watermark",
    description: "C\u00F4ng c\u1EE5 tr\u1EF1c tuy\u1EBFn mi\u1EC5n ph\u00ED t\u1EA3i video t\u1EEB TikTok, YouTube, Facebook, Instagram, Bilibili, Twitter, Xiaohongshu, Douyin kh\u00F4ng watermark.",
    canonical: BASE_URL + "/vi/",
    latestPosts: posts.slice(0, 3),
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

Object.entries(platformRoutes).forEach(([route, key]) => {
  dualRoute(route, (req, res) => {
    const p = req.t.platforms[key];
    res.render("downloader", tplVars(req, {
      title: p.title + " \u2013 SnapClip",
      description: p.description,
      canonical: BASE_URL + req.langPrefix + route,
      platform: p,
      faqSchema: p.faq,
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
  }));
});

dualRoute("/youtube-thumbnail-downloader", (req, res) => {
  res.render("thumbnail-downloader", tplVars(req, {
    title: req.t.thumbPageTitle + " \u2013 SnapClip",
    description: req.t.thumbPageDesc,
    canonical: BASE_URL + req.langPrefix + "/youtube-thumbnail-downloader",
    faqSchema: [{q:req.t.thumbFaq1Q,a:req.t.thumbFaq1A},{q:req.t.thumbFaq2Q,a:req.t.thumbFaq2A}],
  }));
});

dualRoute("/mp4-to-mp3", (req, res) => {
  res.render("converter", tplVars(req, {
    title: (req.t.mp4ToMp3Title || "MP4 to MP3 Converter") + " \u2013 SnapClip",
    description: req.t.mp4ToMp3Desc || "Convert MP4 video to MP3 audio. Paste a URL or upload a file.",
    canonical: BASE_URL + req.langPrefix + "/mp4-to-mp3",
    pageTitle: req.t.mp4ToMp3Title || "MP4 to MP3 Converter",
    pageDesc: req.t.mp4ToMp3Desc || "Convert any video to MP3 audio. Paste a video URL or upload a file.",
    faqSchema: [{q:req.t.converterFaq1Q,a:req.t.converterFaq1A},{q:req.t.converterFaq2Q,a:req.t.converterFaq2A},{q:req.t.converterFaq3Q,a:req.t.converterFaq3A}],
  }));
});

dualRoute("/video-to-audio", (req, res) => {
  res.render("converter", tplVars(req, {
    title: (req.t.videoToAudioTitle || "Video to Audio Converter") + " \u2013 SnapClip",
    description: req.t.videoToAudioDesc || "Extract audio from any video. Supports URL and file upload.",
    canonical: BASE_URL + req.langPrefix + "/video-to-audio",
    pageTitle: req.t.videoToAudioTitle || "Video to Audio Converter",
    pageDesc: req.t.videoToAudioDesc || "Extract audio from any video. Paste a URL or upload a video file.",
    faqSchema: [{q:req.t.converterFaq1Q,a:req.t.converterFaq1A},{q:req.t.converterFaq2Q,a:req.t.converterFaq2A},{q:req.t.converterFaq3Q,a:req.t.converterFaq3A}],
  }));
});

dualRoute("/subtitle-downloader", (req, res) => {
  res.render("subtitle-downloader", tplVars(req, {
    title: req.t.subtitlePageTitle + " \u2013 SnapClip",
    description: req.t.subtitlePageDesc,
    canonical: BASE_URL + req.langPrefix + "/subtitle-downloader",
    faqSchema: [{q:req.t.subFaq1Q,a:req.t.subFaq1A},{q:req.t.subFaq2Q,a:req.t.subFaq2A}],
  }));
});

dualRoute("/video-trimmer", (req, res) => {
  res.render("video-trimmer", tplVars(req, {
    title: req.t.trimmerPageTitle + " \u2013 SnapClip",
    description: req.t.trimmerPageDesc,
    canonical: BASE_URL + req.langPrefix + "/video-trimmer",
    faqSchema: [{q:req.t.trimFaq1Q,a:req.t.trimFaq1A},{q:req.t.trimFaq2Q,a:req.t.trimFaq2A},{q:req.t.trimFaq3Q,a:req.t.trimFaq3A}],
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
  res.render("blog/post", tplVars(req, {
    title: post.title + " \u2013 SnapClip",
    description: post.excerpt,
    canonical: BASE_URL + req.langPrefix + "/blog/" + post.slug,
    post,
    relatedPosts,
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
    { path: "/subtitle-downloader", priority: "0.7", changefreq: "weekly" },
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

// Get video info
app.post("/api/info", async (req, res) => {
  const { url } = req.body;
  if (!url || !isValidUrl(url)) return res.status(400).json({ error: "Invalid URL" });
  if (!isSupportedPlatform(url)) return res.status(400).json({ error: "Unsupported platform" });

  // Douyin: use direct handler (no yt-dlp)
  if (isDouyinUrl(url)) {
    try {
      const info = await getDouyinInfo(url);
      return res.json(info);
    } catch (err) {
      console.error("[Douyin info]", err.message);
      return res.status(500).json({ error: "Cannot fetch Douyin video info. Please check the URL." });
    }
  }

  const cached = getCachedInfo(url);
  if (cached) return res.json(cached);

  execFile("yt-dlp", ["--no-warnings", "--dump-json", "--no-playlist", url],
    { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
    if (err) {
      return res.status(500).json({ error: "Cannot fetch video info. Check URL." });
    }
    try {
      const info = JSON.parse(stdout);
      let formats = (info.formats || [])
        .filter(f => f.vcodec !== "none" && f.acodec !== "none" && f.url)
        .map(f => ({
          formatId: f.format_id, ext: f.ext,
          resolution: f.resolution || `${f.width || "?"}x${f.height || "?"}`,
          height: f.height || 0,
          filesize: f.filesize || f.filesize_approx || null,
          quality: f.format_note || f.quality || "",
        }));
      formats.sort((a, b) => b.height - a.height);
      const seen = new Set();
      formats = formats.filter(f => { if (seen.has(f.resolution)) return false; seen.add(f.resolution); return true; });
      formats = formats.map(({ height, ...r }) => r);
      const payload = {
        title: info.title || "Video", thumbnail: info.thumbnail || null,
        duration: info.duration || null, uploader: info.uploader || info.channel || "",
        platform: info.extractor_key || info.extractor || "",
        formats: formats.length ? formats : [{ formatId: "best", ext: "mp4", resolution: "Best", quality: "best" }],
      };
      setCachedInfo(url, payload);
      res.json(payload);
    } catch { res.status(500).json({ error: "Failed to parse video info" }); }
  });
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
  const args = ["--no-warnings", "--no-playlist", "--newline", "-N", "4", "-o", outTpl, "--merge-output-format", "mp4"];
  if (formatId && formatId !== "best") {
    const safeFormat = String(formatId).replace(/[^a-zA-Z0-9+_-]/g, "");
    args.push("-f", `${safeFormat}+bestaudio/best`);
  } else {
    args.push("-f", "best[ext=mp4]/best");
  }
  args.push(url);

  downloadJobs.set(jobId, { status: "downloading", percent: 0, speed: "", eta: "" });
  res.json({ jobId });

  const proc = spawn("yt-dlp", args);
  const killTimer = setTimeout(() => {
    try { proc.kill("SIGKILL"); } catch {}
  }, 10 * 60 * 1000);
  let stdoutBuf = "";
  proc.stdout.on("data", (chunk) => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split(/\r?\n/);
    stdoutBuf = lines.pop();
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
    if (code !== 0) {
      downloadJobs.set(jobId, { status: "error", percent: 0 });
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
    downloadJobs.set(jobId, { status: "done", percent: 100, downloadUrl: `/api/file/${fileId}${ext}`, filename: `video${ext}` });
    autoDeleteFile(filePath);
    cleanupJob(jobId);
  });
});

// Download MP3 (audio extraction)
app.post("/api/download-mp3", (req, res) => {
  const { url } = req.body;
  if (!url || !isValidUrl(url)) return res.status(400).json({ error: "Invalid URL" });
  if (!isSupportedPlatform(url)) return res.status(400).json({ error: "Unsupported platform" });

  const fileId = uuidv4();
  const jobId = uuidv4();
  const outTpl = path.join(DOWNLOAD_DIR, `${fileId}.%(ext)s`);
  const args = ["--no-warnings", "--no-playlist", "--newline", "-N", "4", "-o", outTpl, "-x", "--audio-format", "mp3", url];

  downloadJobs.set(jobId, { status: "downloading", percent: 0, speed: "", eta: "" });
  res.json({ jobId });

  const proc = spawn("yt-dlp", args);
  const killTimer = setTimeout(() => {
    try { proc.kill("SIGKILL"); } catch {}
  }, 10 * 60 * 1000);
  let stdoutBuf = "";
  proc.stdout.on("data", (chunk) => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split(/\r?\n/);
    stdoutBuf = lines.pop();
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
    if (code !== 0) {
      downloadJobs.set(jobId, { status: "error", percent: 0 });
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

// Subtitles list
app.post("/api/subtitles", (req, res) => {
  const { url } = req.body;
  if (!url || !isValidUrl(url)) return res.status(400).json({ error: "Invalid URL" });

  execFile("yt-dlp", ["--no-warnings", "--dump-json", "--no-playlist", url],
    { timeout: 20000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
    if (err) return res.status(500).json({ error: "Cannot fetch video info" });
    try {
      const info = JSON.parse(stdout);
      const subs = [];
      const addSubs = (obj, prefix) => {
        if (!obj) return;
        Object.entries(obj).forEach(([code, formats]) => {
          const name = (formats[0] && formats[0].name) || code;
          subs.push({ code, lang: prefix + name });
        });
      };
      addSubs(info.subtitles, "");
      addSubs(info.automatic_captions, "[Auto] ");
      res.json({ subtitles: subs });
    } catch { res.status(500).json({ error: "Failed to parse info" }); }
  });
});

// Subtitle file download
app.get("/api/subtitle-file", (req, res) => {
  const { url, lang } = req.query;
  if (!url || !isValidUrl(url) || !lang) return res.status(400).json({ error: "Invalid parameters" });
  if (!/^[a-zA-Z0-9_-]+$/.test(lang)) return res.status(400).json({ error: "Invalid language code" });

  const fileId = uuidv4();
  const outTpl = path.join(DOWNLOAD_DIR, fileId);
  const args = ["--no-warnings", "--no-playlist", "--write-sub", "--write-auto-sub",
    "--sub-lang", lang, "--sub-format", "srt", "--skip-download", "-o", outTpl, url];

  execFile("yt-dlp", args, { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }, (err) => {
    if (err) return res.status(500).json({ error: "Subtitle download failed" });
    const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.startsWith(fileId) && f.endsWith(".srt"));
    if (!files.length) return res.status(404).json({ error: "No subtitle file generated" });
    const filePath = path.join(DOWNLOAD_DIR, files[0]);
    res.download(filePath, `subtitle_${lang}.srt`, () => autoDeleteFile(filePath, 60000));
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
  const names = { ".mp4": "video.mp4", ".mp3": "audio.mp3", ".srt": "subtitle.srt" };
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
