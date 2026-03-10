const puppeteer = require("puppeteer-core");
const fs = require("fs");
const path = require("path");

const COOKIES_FILE = path.join(__dirname, "cookies.txt");
const REFRESH_INTERVAL = 3600000; // 1 hour
const CHROMIUM_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium";

async function fetchDouyinCookies() {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      executablePath: CHROMIUM_PATH,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );
    await page.goto("https://www.douyin.com/", { waitUntil: "networkidle2", timeout: 30000 });
    // Wait a bit for JS-generated cookies
    await new Promise((r) => setTimeout(r, 3000));
    const cookies = await page.cookies("https://www.douyin.com");
    await browser.close();
    browser = null;

    if (!cookies.length) {
      console.log("[cookies] No cookies received from Douyin");
      return false;
    }

    // Write Netscape cookie format
    const lines = ["# Netscape HTTP Cookie File"];
    for (const c of cookies) {
      const domain = c.domain.startsWith(".") ? c.domain : "." + c.domain;
      const expiry = c.expires ? Math.floor(c.expires) : 0;
      const secure = c.secure ? "TRUE" : "FALSE";
      lines.push(`${domain}\tTRUE\t${c.path}\t${secure}\t${expiry}\t${c.name}\t${c.value}`);
    }
    fs.writeFileSync(COOKIES_FILE, lines.join("\n") + "\n");
    console.log(`[cookies] Refreshed ${cookies.length} Douyin cookies`);
    return true;
  } catch (err) {
    console.error("[cookies] Failed to refresh:", err.message);
    if (browser) try { await browser.close(); } catch {}
    return false;
  }
}

let refreshTimer = null;

function startCookieRefresh() {
  // Initial fetch
  fetchDouyinCookies().then((ok) => {
    if (ok) console.log("[cookies] Initial cookie fetch successful");
    else console.log("[cookies] Initial cookie fetch failed, will retry");
  });
  // Periodic refresh
  refreshTimer = setInterval(() => fetchDouyinCookies(), REFRESH_INTERVAL);
}

function stopCookieRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
}

module.exports = { fetchDouyinCookies, startCookieRefresh, stopCookieRefresh, COOKIES_FILE };
