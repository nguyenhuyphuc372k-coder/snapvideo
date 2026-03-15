/* eslint-disable no-console */

const http = require('http');
const https = require('https');

const DEFAULT_BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 10 * 60 * 1000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 750);
// To avoid huge downloads (e.g. Facebook), cap bytes. Set MAX_BYTES=0 to disable.
const MAX_BYTES = Number(process.env.MAX_BYTES || 25 * 1024 * 1024);

const SAMPLE_URLS = [
  {
    platform: 'YouTube',
    urls: [
      // From yt-dlp extractor tests (currently available as of this run)
      'https://youtu.be/yeWKywCrFtk',
    ],
    mode: 'stream',
  },
  {
    platform: 'TikTok',
    urls: [
      // From yt-dlp extractor tests (short, historically stable)
      'https://www.tiktok.com/@pokemonlife22/video/7059698374567611694',
      'https://www.tiktok.com/@moxypatch/video/7206382937372134662',
    ],
    mode: 'stream',
  },
  {
    platform: 'Facebook',
    urls: [
      // From yt-dlp extractor tests; may be geo/login dependent
      'https://www.facebook.com/WatchESLOne/videos/359649331226507/',
    ],
    mode: 'stream',
  },
  {
    platform: 'Instagram',
    urls: [
      // From yt-dlp extractor tests; often blocked by login wall
      'https://www.instagram.com/reel/Chunk8-jurw/',
      'https://instagram.com/p/aye83DjauH/',
    ],
    mode: 'stream',
  },
  {
    platform: 'Bilibili',
    urls: [
      // From yt-dlp extractor tests
      'https://www.bilibili.com/video/BV13x41117TL',
    ],
    mode: 'stream',
  },
  {
    platform: 'Twitter/X',
    urls: [
      // From yt-dlp extractor tests; may be rate-limited or auth gated
      'https://x.com/historyinmemes/status/1790637656616943991',
    ],
    mode: 'stream',
  },
  {
    platform: 'Xiaohongshu',
    urls: [
      'http://xhslink.com/o/6h6omiZTKhr',
    ],
    mode: 'stream',
  },
  {
    platform: 'Douyin',
    urls: [
      // From yt-dlp TikTok extractor tests (DouyinIE)
      'https://www.douyin.com/video/6961737553342991651',
    ],
    mode: 'file',
  },
];

function nowMs() {
  return Date.now();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function joinUrl(base, path) {
  const b = String(base || '').replace(/\/+$/, '');
  const p = String(path || '').startsWith('/') ? String(path || '') : `/${path}`;
  return b + p;
}

function requestRaw(method, urlStr, { headers = {}, body = null, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;

    const reqHeaders = {
      'user-agent': 'Mozilla/5.0 (SnapClipBench/1.0; +https://snapclip.pro)',
      accept: '*/*',
      ...headers,
    };

    const start = nowMs();
    const req = lib.request(
      {
        method,
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: reqHeaders,
      },
      (res) => {
        resolve({ res, start });
      }
    );

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      try {
        req.destroy(new Error(`Request timeout after ${timeoutMs}ms`));
      } catch {
        // ignore
      }
    });

    if (body) req.write(body);
    req.end();
  });
}

async function requestJson(method, urlStr, jsonBody) {
  const body = jsonBody != null ? Buffer.from(JSON.stringify(jsonBody), 'utf8') : null;
  const { res, start } = await requestRaw(method, urlStr, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(body ? { 'content-length': String(body.length) } : {}),
      accept: 'application/json',
    },
    body,
  });

  const chunks = [];
  let total = 0;
  const MAX = 5 * 1024 * 1024;

  const data = await new Promise((resolve, reject) => {
    res.on('data', (c) => {
      total += c.length;
      if (total <= MAX) chunks.push(c);
    });
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
  });

  const durationMs = nowMs() - start;
  let parsed = null;
  try {
    parsed = JSON.parse(data);
  } catch {
    parsed = { _raw: data };
  }

  return {
    statusCode: res.statusCode || 0,
    headers: res.headers,
    json: parsed,
    durationMs,
  };
}

async function downloadToNull(urlStr) {
  const { res, start } = await requestRaw('GET', urlStr);

  let firstByteAt = null;
  let bytes = 0;
  let aborted = false;

  await new Promise((resolve, reject) => {
    res.on('data', (c) => {
      if (firstByteAt == null) firstByteAt = nowMs();
      bytes += c.length;

      if (MAX_BYTES > 0 && bytes >= MAX_BYTES && !aborted) {
        aborted = true;
        try { res.destroy(); } catch {}
        resolve(null);
      }
    });
    res.on('end', () => resolve(null));
    res.on('error', reject);
  });

  const end = nowMs();
  return {
    statusCode: res.statusCode || 0,
    ttfbMs: firstByteAt == null ? null : firstByteAt - start,
    totalMs: end - start,
    bytes,
    aborted,
  };
}

async function pollProgress(baseUrl, jobId) {
  const startedAt = nowMs();
  while (true) {
    const p = await requestJson('GET', joinUrl(baseUrl, `/api/progress/${jobId}`));
    if (p.statusCode !== 200) {
      return { ok: false, error: `progress http ${p.statusCode}`, last: p.json, waitMs: nowMs() - startedAt };
    }
    const st = p.json;
    if (!st || typeof st !== 'object') {
      return { ok: false, error: 'progress invalid json', last: st, waitMs: nowMs() - startedAt };
    }
    if (st.status === 'done') {
      return { ok: true, status: st, waitMs: nowMs() - startedAt };
    }
    if (st.status === 'error') {
      const extra = st.error ? `: ${String(st.error).slice(0, 300)}` : '';
      return { ok: false, error: 'download error' + extra, status: st, waitMs: nowMs() - startedAt };
    }
    if (nowMs() - startedAt > TIMEOUT_MS) {
      return { ok: false, error: 'progress timeout', status: st, waitMs: nowMs() - startedAt };
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

function ms(v) {
  if (v == null) return '—';
  return `${Math.round(v)}ms`;
}

function bytesToMiB(n) {
  if (!Number.isFinite(n)) return '—';
  return `${(n / (1024 * 1024)).toFixed(2)}MiB`;
}

async function tryUrlsSequential(label, urls, fn) {
  let lastErr = null;
  for (const url of urls) {
    try {
      const r = await fn(url);
      return { ok: true, url, result: r };
    } catch (e) {
      lastErr = e;
      console.warn(`  - ${label}: failed for ${url}: ${e && e.message ? e.message : String(e)}`);
    }
  }
  return { ok: false, error: lastErr ? (lastErr.message || String(lastErr)) : 'unknown error' };
}

async function runOne(baseUrl, entry) {
  console.log(`\n== ${entry.platform} ==`);

  // 1) /api/info timing (with retry across sample URLs)
  const infoAttempt = await tryUrlsSequential('info', entry.urls, async (url) => {
    const r = await requestJson('POST', joinUrl(baseUrl, '/api/info'), { url });
    if (r.statusCode !== 200) {
      const msg = (r.json && r.json.error) ? r.json.error : `http ${r.statusCode}`;
      throw new Error(msg);
    }
    return r;
  });
  const url = infoAttempt.ok ? infoAttempt.url : entry.urls[0];
  const infoRes = infoAttempt.ok ? infoAttempt.result : null;

  console.log(`  url: ${url}`);
  if (infoRes) {
    console.log(`  /api/info: ${ms(infoRes.durationMs)} (platform=${infoRes.json.platform || 'n/a'})`);
  } else {
    console.log(`  /api/info: FAIL (${infoAttempt.error})`);
  }

  // 2) download check
  if (entry.mode === 'stream') {
    // Attempt streaming first; if it fails (or yields 0 bytes), fall back to file-based like the UI.
    let streamAttempt = null;
    try {
      const create = await requestJson('POST', joinUrl(baseUrl, '/api/download-stream'), { url, formatId: 'best' });
      if (create.statusCode !== 200) {
        const msg = (create.json && create.json.error) ? create.json.error : `http ${create.statusCode}`;
        throw new Error(`download-stream create failed: ${msg}`);
      }

      const streamUrl = joinUrl(baseUrl, create.json.streamUrl);
      console.log(`  stream: ${streamUrl}`);
      const dl = await downloadToNull(streamUrl);
      streamAttempt = dl;

      const streamOk = dl.statusCode === 200 && dl.bytes > 0;
      if (streamOk) {
        const note = dl.aborted ? ` (partial, capped at ${bytesToMiB(MAX_BYTES)})` : '';
        console.log(`  stream TTFB: ${ms(dl.ttfbMs)}; total: ${ms(dl.totalMs)}; size: ${bytesToMiB(dl.bytes)}${note}`);
        return {
          platform: entry.platform,
          ok: true,
          url,
          infoMs: infoRes ? infoRes.durationMs : null,
          streamTtfbMs: dl.ttfbMs,
          streamTotalMs: dl.totalMs,
          bytes: dl.bytes,
          note: dl.aborted ? 'partial' : null,
        };
      }

      console.log(`  stream: FAIL (http=${dl.statusCode}, bytes=${dl.bytes}) -> fallback`);
    } catch (e) {
      console.log(`  stream: FAIL (${e && e.message ? e.message : String(e)}) -> fallback`);
    }

    // Fallback to file-based download
    const fb = await requestJson('POST', joinUrl(baseUrl, '/api/download'), { url, formatId: 'best' });
    if (fb.statusCode !== 200) {
      const msg = (fb.json && fb.json.error) ? fb.json.error : `http ${fb.statusCode}`;
      return {
        platform: entry.platform,
        ok: false,
        url,
        infoMs: infoRes ? infoRes.durationMs : null,
        streamTtfbMs: streamAttempt ? streamAttempt.ttfbMs : null,
        streamTotalMs: streamAttempt ? streamAttempt.totalMs : null,
        bytes: streamAttempt ? streamAttempt.bytes : null,
        error: `fallback /api/download create failed: ${msg}`,
      };
    }
    const jobId = fb.json.jobId;
    console.log(`  fallback download job: ${jobId}`);
    const poll = await pollProgress(baseUrl, jobId);
    if (!poll.ok) {
      return {
        platform: entry.platform,
        ok: false,
        url,
        infoMs: infoRes ? infoRes.durationMs : null,
        downloadWaitMs: poll.waitMs,
        error: `fallback download failed: ${poll.error}`,
      };
    }
    const downloadUrl = joinUrl(baseUrl, poll.status.downloadUrl);
    console.log(`  fallback file: ${downloadUrl}`);
    const dl = await downloadToNull(downloadUrl);
    const note = dl.aborted ? ` (partial, capped at ${bytesToMiB(MAX_BYTES)})` : '';
    console.log(`  file TTFB: ${ms(dl.ttfbMs)}; total: ${ms(dl.totalMs)}; size: ${bytesToMiB(dl.bytes)}${note}`);

    const ok = dl.statusCode === 200 && dl.bytes > 0;
    return {
      platform: entry.platform,
      ok,
      url,
      infoMs: infoRes ? infoRes.durationMs : null,
      downloadWaitMs: poll.waitMs,
      fileTtfbMs: dl.ttfbMs,
      fileTotalMs: dl.totalMs,
      bytes: dl.bytes,
      note: dl.aborted ? 'partial' : 'fallback',
      error: ok ? null : `file http ${dl.statusCode} / bytes=${dl.bytes}`,
    };
  }

  // file-based (Douyin)
  const create = await requestJson('POST', joinUrl(baseUrl, '/api/download'), { url, formatId: 'nowm' });
  if (create.statusCode !== 200) {
    const msg = (create.json && create.json.error) ? create.json.error : `http ${create.statusCode}`;
    return {
      platform: entry.platform,
      ok: false,
      url,
      infoMs: infoRes ? infoRes.durationMs : null,
      error: `download create failed: ${msg}`,
    };
  }

  const jobId = create.json.jobId;
  console.log(`  download job: ${jobId}`);
  const poll = await pollProgress(baseUrl, jobId);
  if (!poll.ok) {
    return {
      platform: entry.platform,
      ok: false,
      url,
      infoMs: infoRes ? infoRes.durationMs : null,
      downloadWaitMs: poll.waitMs,
      error: `download failed: ${poll.error}`,
    };
  }

  const downloadUrl = joinUrl(baseUrl, poll.status.downloadUrl);
  console.log(`  file: ${downloadUrl}`);
  const dl = await downloadToNull(downloadUrl);
  const note = dl.aborted ? ` (partial, capped at ${bytesToMiB(MAX_BYTES)})` : '';
  console.log(`  file TTFB: ${ms(dl.ttfbMs)}; total: ${ms(dl.totalMs)}; size: ${bytesToMiB(dl.bytes)}${note}`);

  return {
    platform: entry.platform,
    ok: dl.statusCode === 200 && dl.bytes > 0,
    url,
    infoMs: infoRes ? infoRes.durationMs : null,
    downloadWaitMs: poll.waitMs,
    fileTtfbMs: dl.ttfbMs,
    fileTotalMs: dl.totalMs,
    bytes: dl.bytes,
    note: dl.aborted ? 'partial' : null,
    error: (dl.statusCode === 200 && dl.bytes > 0) ? null : `file http ${dl.statusCode} / bytes=${dl.bytes}`,
  };
}

async function main() {
  const baseUrl = DEFAULT_BASE_URL;
  console.log(`Base URL: ${baseUrl}`);

  // Warm-up (reduce cold-start noise)
  try {
    const ping = await requestJson('GET', joinUrl(baseUrl, '/api/ping'));
    console.log(`Warm-up /api/ping: http ${ping.statusCode} in ${ms(ping.durationMs)}`);
  } catch (e) {
    console.warn(`Warm-up failed: ${e && e.message ? e.message : String(e)}`);
  }

  const results = [];
  for (const entry of SAMPLE_URLS) {
    try {
      const r = await runOne(baseUrl, entry);
      results.push(r);
    } catch (e) {
      results.push({
        platform: entry.platform,
        ok: false,
        url: entry.urls[0],
        error: e && e.message ? e.message : String(e),
      });
    }
  }

  console.log('\n=== Summary ===');
  for (const r of results) {
    const status = r.ok ? 'OK' : 'FAIL';
    const parts = [
      `${status} ${r.platform}`,
      `info=${ms(r.infoMs)}`,
    ];
    if (r.streamTtfbMs != null) parts.push(`streamTTFB=${ms(r.streamTtfbMs)}`);
    if (r.streamTotalMs != null) parts.push(`streamTotal=${ms(r.streamTotalMs)}`);
    if (r.downloadWaitMs != null) parts.push(`downloadWait=${ms(r.downloadWaitMs)}`);
    if (r.fileTotalMs != null) parts.push(`fileTotal=${ms(r.fileTotalMs)}`);
    if (r.bytes != null) parts.push(`size=${bytesToMiB(r.bytes)}`);
    if (r.note) parts.push(`note=${r.note}`);
    if (r.error) parts.push(`err=${r.error}`);
    console.log(' - ' + parts.join(' | '));
  }

  // Machine-readable output (optional)
  if (String(process.env.JSON || '').toLowerCase() === '1') {
    console.log('\n=== JSON ===');
    console.log(JSON.stringify({ baseUrl, results }, null, 2));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
