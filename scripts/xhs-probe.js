// Probe Xiaohongshu page structure to find video URLs
const https = require("https");

const URLS = [
  "https://www.xiaohongshu.com/explore/6411cf99000000001300b6d9",
  "https://www.xiaohongshu.com/discovery/item/6411cf99000000001300b6d9",
];

const UA_MOBILE = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";
const UA_DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

function httpGet(urlStr, ua) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: "GET",
        headers: {
          "User-Agent": ua,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
      },
      (res) => {
        if ([301, 302, 303, 307].includes(res.statusCode) && res.headers.location) {
          const next = res.headers.location.startsWith("http")
            ? res.headers.location
            : new URL(res.headers.location, urlStr).href;
          console.log(`  Redirect ${res.statusCode} -> ${next}`);
          res.resume();
          return resolve(httpGet(next, ua));
        }
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
      }
    );
    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
    req.end();
  });
}

async function probe(urlStr, ua, label) {
  console.log(`\n=== ${label}: ${urlStr} ===`);
  try {
    const { status, body } = await httpGet(urlStr, ua);
    console.log("  Status:", status, "Body length:", body.length);

    // __INITIAL_STATE__
    const m1 = body.match(/__INITIAL_STATE__\s*=\s*(\{[\s\S]+?\})\s*<\/script/);
    if (m1) {
      console.log("  Found __INITIAL_STATE__, length:", m1[1].length);
      console.log("  First 3000 chars:", m1[1].substring(0, 3000));
    }

    // window.__INITIAL_SSR_STATE__
    const m2 = body.match(/window\.__INITIAL_SSR_STATE__\s*=\s*(\{[\s\S]+?\})\s*;?\s*<\/script/);
    if (m2) {
      console.log("  Found __INITIAL_SSR_STATE__, length:", m2[1].length);
      console.log("  First 2000 chars:", m2[1].substring(0, 2000));
    }

    // MP4 URLs anywhere
    const mp4s = body.match(/"(https?:\/\/[^"]+\.mp4[^"]*)"/g);
    if (mp4s) {
      console.log("  MP4 URLs found:", mp4s.length);
      mp4s.forEach((v) => console.log("   ", v.substring(0, 200)));
    }

    // og:video meta
    const ogVideo =
      body.match(/<meta[^>]+property=["']og:video["'][^>]+content=["']([^"']+)["'][^>]*>/i) ||
      body.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:video["'][^>]*>/i);
    if (ogVideo) console.log("  og:video:", ogVideo[1]);

    // og:image
    const ogImage =
      body.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i) ||
      body.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["'][^>]*>/i);
    if (ogImage) console.log("  og:image:", ogImage[1]);

    // og:title
    const ogTitle =
      body.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["'][^>]*>/i) ||
      body.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["'][^>]*>/i);
    if (ogTitle) console.log("  og:title:", ogTitle[1]);

    // video tag src
    const videoSrc = body.match(/<video[^>]+src=["']([^"']+)["']/i);
    if (videoSrc) console.log("  <video> src:", videoSrc[1]);

    // any window.__xxx pattern
    const winVars = body.match(/window\.__\w+/g);
    if (winVars) console.log("  window.__ vars:", [...new Set(winVars)]);

    // Look for "video" keys near URLs
    const videoKeys = body.match(/"video[^"]*"\s*:\s*\{[^}]{0,500}\}/g);
    if (videoKeys) {
      console.log("  Video-like JSON keys:", videoKeys.length);
      videoKeys.slice(0, 3).forEach((v) => console.log("   ", v.substring(0, 300)));
    }

    // SNS share / originVideoKey patterns
    const originVideo = body.match(/originVideoKey|video_id|videoUrl|playAddr|stream_url/gi);
    if (originVideo) console.log("  Video key patterns:", [...new Set(originVideo)]);

    if (!m1 && !m2 && !mp4s && !ogVideo && !videoSrc) {
      console.log("  *** No video data found. First 4000 chars of body:");
      console.log(body.substring(0, 4000));
    }
  } catch (err) {
    console.error("  Error:", err.message);
  }
}

(async () => {
  for (const url of URLS) {
    await probe(url, UA_DESKTOP, "Desktop");
    await probe(url, UA_MOBILE, "Mobile");
  }
})();
