const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

const UA_MOBILE = "Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

function httpGet(urlStr, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: "GET", headers: { "User-Agent": UA_MOBILE, Accept: "text/html" } },
      (res) => {
        if ([301, 302, 303, 307].includes(res.statusCode) && res.headers.location && maxRedirects > 0) {
          const next = res.headers.location.startsWith("http") ? res.headers.location : new URL(res.headers.location, urlStr).href;
          res.resume();
          return resolve(httpGet(next, maxRedirects - 1));
        }
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      }
    );
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Request timeout")); });
    req.end();
  });
}

// Resolve short URL (v.douyin.com/xxx) to video ID
async function resolveDouyinId(url) {
  const directMatch = url.match(/douyin\.com\/video\/(\d+)/);
  if (directMatch) return directMatch[1];

  // Follow redirects from short URL to get the video ID
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: "HEAD", headers: { "User-Agent": UA_MOBILE } },
      (res) => {
        const loc = res.headers.location || "";
        const m = loc.match(/video\/(\d+)/);
        if (m) return resolve(m[1]);
        // Try second hop
        if (loc) {
          const u2 = new URL(loc.startsWith("http") ? loc : new URL(loc, url).href);
          const req2 = https.request(
            { hostname: u2.hostname, path: u2.pathname + u2.search, method: "HEAD", headers: { "User-Agent": UA_MOBILE } },
            (res2) => {
              const loc2 = res2.headers.location || "";
              const m2 = loc2.match(/video\/(\d+)/);
              if (m2) return resolve(m2[1]);
              reject(new Error("Could not resolve Douyin video ID"));
            }
          );
          req2.on("error", reject);
          req2.setTimeout(10000, () => { req2.destroy(); reject(new Error("Timeout")); });
          req2.end();
        } else {
          reject(new Error("No redirect from Douyin short URL"));
        }
      }
    );
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

// Fetch video info from mobile page
async function getDouyinInfo(url) {
  const videoId = await resolveDouyinId(url);
  const resp = await httpGet(`https://m.douyin.com/share/video/${videoId}`);

  const m = resp.body.match(/_ROUTER_DATA\s*=\s*(\{.+?\})\s*;?\s*<\/script/s);
  if (!m) throw new Error("Could not parse Douyin page data");

  const routerData = JSON.parse(m[1]);
  const pageData = routerData.loaderData?.["video_(id)/page"];
  if (!pageData?.videoInfoRes?.item_list?.length) throw new Error("No video data found");

  const item = pageData.videoInfoRes.item_list[0];
  const video = item.video || {};
  const playAddr = video.play_addr;
  if (!playAddr?.url_list?.length) throw new Error("No video URL found");

  // Build no-watermark URL by replacing playwm with play
  const wmUrl = playAddr.url_list[0];
  const noWmUrl = wmUrl.replace("/playwm/", "/play/");

  const cover = video.cover?.url_list?.[0] || null;
  const w = video.width || 0;
  const h = video.height || 0;
  const durationMs = video.duration || 0;

  return {
    title: item.desc || "Douyin Video",
    thumbnail: cover,
    duration: durationMs > 0 ? Math.round(durationMs / 1000) : null,
    uploader: item.author?.nickname || "",
    platform: "Douyin",
    videoId,
    videoUrl: noWmUrl,
    videoUrlWm: wmUrl,
    width: w,
    height: h,
    formats: [
      { formatId: "nowm", ext: "mp4", resolution: w && h ? `${w}x${h}` : "Original", quality: "No watermark" },
      { formatId: "wm", ext: "mp4", resolution: w && h ? `${w}x${h}` : "Original", quality: "With watermark" },
    ],
  };
}

// Download video to a file
function downloadDouyinVideo(videoUrl, destPath, onProgress) {
  return new Promise((resolve, reject) => {

    function doDownload(downloadUrl, redirects = 5) {
      const du = new URL(downloadUrl);
      const dlib = du.protocol === "https:" ? https : http;
      const req = dlib.request(
        { hostname: du.hostname, path: du.pathname + du.search, method: "GET", headers: { "User-Agent": UA_MOBILE, Referer: "https://www.douyin.com/" } },
        (res) => {
          if ([301, 302, 303, 307].includes(res.statusCode) && res.headers.location && redirects > 0) {
            res.resume();
            return doDownload(res.headers.location, redirects - 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`Download failed with status ${res.statusCode}`));
          }
          const totalBytes = parseInt(res.headers["content-length"], 10) || 0;
          let downloaded = 0;
          const ws = fs.createWriteStream(destPath);
          res.on("data", (chunk) => {
            downloaded += chunk.length;
            if (totalBytes > 0 && onProgress) {
              onProgress(Math.min(100, Math.round((downloaded / totalBytes) * 100)));
            }
          });
          res.pipe(ws);
          ws.on("finish", () => resolve({ totalBytes: downloaded }));
          ws.on("error", reject);
        }
      );
      req.on("error", reject);
      req.setTimeout(120000, () => { req.destroy(); reject(new Error("Download timeout")); });
      req.end();
    }

    doDownload(videoUrl);
  });
}

function isDouyinUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname === "douyin.com" || u.hostname.endsWith(".douyin.com");
  } catch {
    return false;
  }
}

module.exports = { getDouyinInfo, downloadDouyinVideo, isDouyinUrl, resolveDouyinId };
