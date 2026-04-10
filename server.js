const path      = require('path');
const fs        = require('fs');
const crypto    = require('crypto');
const https     = require('https');
const http      = require('http');
const { v4: uuidv4 }  = require('uuid');
const { exec, spawn } = require('child_process');
const { promisify }   = require('util');
const execAsync       = promisify(exec);
const readline        = require('readline');

const httpsAgent = new https.Agent({
    keepAlive: true, keepAliveMsecs: 15000,
    maxSockets: 3, maxFreeSockets: 1,
    timeout: 6000, scheduling: 'lifo', family: 4,
});

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT             = process.env.PORT || 3556;
const MP3_STORAGE_PATH = path.join(__dirname, 'temp', 'mp3');
const WEB_ROOT         = path.join(__dirname, 'web');
const MAX_REQUESTS     = parseInt(process.env.MAX_REQUESTS) || 100;
const TIME_WINDOW      = parseInt(process.env.TIME_WINDOW)  || 60000;
const FILE_TTL_MS      = 60 * 60 * 1000; // 1 hour
const QUEUE_CONCURRENCY = 2;
const CACHE_DIR = path.join(MP3_STORAGE_PATH, '.cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/+$/, '');

const ACOUSTID_KEY = process.env.ACOUSTID_KEY || 'gqaHKRGZFM';

function getFpcalcPath() {
    const candidates = [
        '/usr/bin/fpcalc',
        '/usr/local/bin/fpcalc',
        path.join(process.env.HOME || '/root', '.local/bin/fpcalc'),
    ];
    for (const p of candidates) {
        try { if (fs.existsSync(p)) return p; } catch {}
    }
    return null;
}
const FPCALC_PATH = getFpcalcPath();

const COOKIES_FILE = (() => {
    const p = '/home/homemc/ytcookie.txt';
    try { return fs.existsSync(p) ? p : null; } catch { return null; }
})();



const API_KEY_FILE = path.join(__dirname, '.apikey');
let API_KEY = '';

function loadOrCreateApiKey() {
    try {
        if (fs.existsSync(API_KEY_FILE)) {
            API_KEY = fs.readFileSync(API_KEY_FILE, 'utf8').trim();
            if (API_KEY.length >= 32) return;
        }
    } catch {}
    API_KEY = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(API_KEY_FILE, API_KEY, { mode: 0o600 });
    logger.success(`Generated new API key → ${API_KEY_FILE}`);
}

// ─── Logger ───────────────────────────────────────────────────────────────────

const logger = {
    info:    (...a) => console.log('ℹ️ ', ...a),
    success: (...a) => console.log('✅', ...a),
    error:   (...a) => console.error('❌', ...a),
    warn:    (...a) => console.warn('⚠️ ', ...a),
    divider: (m='') => console.log('─────────────────────────────────────────', m),
};

// ─── Storage ──────────────────────────────────────────────────────────────────

if (!fs.existsSync(MP3_STORAGE_PATH)) {
    fs.mkdirSync(MP3_STORAGE_PATH, { recursive: true });
    logger.success(`Storage created: ${MP3_STORAGE_PATH}`);
}

function isValidYouTubeUrl(url) {
    if (typeof url !== 'string') return false;
    try {
        const u = new URL(url);
        return u.hostname.includes('youtu') || u.hostname.includes('youtube');
    } catch { return false; }
}

// ─── Persistent file registry ────────────────────────────────────────────────
// Stored as JSON on disk so files are still cleaned up after server restarts.
// Without this, every restart orphaned all temp files permanently.

const REGISTRY_PATH = path.join(MP3_STORAGE_PATH, '.registry.json');

const fileRegistry = new Map(); // name → expiresAt (ms)

function saveRegistry() {
    try {
        const obj = {};
        for (const [k, v] of fileRegistry) obj[k] = v;
        fs.writeFileSync(REGISTRY_PATH, JSON.stringify(obj));
    } catch {}
}

function loadRegistry() {
    try {
        const raw = fs.readFileSync(REGISTRY_PATH, 'utf8');
        const obj = JSON.parse(raw);
        const now = Date.now();
        for (const [k, v] of Object.entries(obj)) {
            if (v > now) fileRegistry.set(k, v); // skip already-expired entries
        }
        logger.info(`Registry loaded: ${fileRegistry.size} tracked files`);
    } catch {}
}

function registerFile(filePath) {
    const name = path.basename(filePath);
    const expiresAt = Date.now() + FILE_TTL_MS;
    fileRegistry.set(name, expiresAt);
    saveRegistry();
}

function renewFile(filePath) {
    const name = path.basename(filePath);
    if (fileRegistry.has(name)) {
        fileRegistry.set(name, Date.now() + FILE_TTL_MS);
        saveRegistry();
        logger.info(`TTL renewed: ${name}`);
    }
}

function startCleanupSweep() {
    // Run once at startup to immediately delete anything already expired
    function sweep() {
        const now = Date.now();
        let changed = false;
        for (const [name, expiresAt] of fileRegistry) {
            if (now >= expiresAt) {
                const full = path.join(MP3_STORAGE_PATH, name);
                try { fs.unlinkSync(full); logger.info(`Swept: ${name}`); } catch {}
                fileRegistry.delete(name);
                changed = true;
            }
        }
        if (changed) saveRegistry();

        // Also sweep orphaned temp files (no registry entry, older than 2h)
        try {
            for (const f of fs.readdirSync(MP3_STORAGE_PATH)) {
                if (!f.startsWith('temp_') && !f.startsWith('batch_')) continue;
                const full = path.join(MP3_STORAGE_PATH, f);
                try {
                    if (now - fs.statSync(full).mtimeMs > 2 * 60 * 60 * 1000) {
                        fs.unlinkSync(full);
                        logger.info(`Orphan swept: ${f}`);
                    }
                } catch {}
            }
        } catch {}
    }

    sweep(); // immediate pass on startup
    setInterval(sweep, 5 * 60 * 1000);
}

// ─── yt-dlp / deno detection ──────────────────────────────────────────────────

function getYtDlpPath() {
    const candidates = [
        '/usr/bin/yt-dlp',
        '/usr/local/bin/yt-dlp',
        '/snap/bin/yt-dlp',
        path.join(process.env.HOME || '/root', '.local/bin/yt-dlp'),
        path.join(__dirname, 'node_modules', 'yt-dlp-exec', 'bin', 'yt-dlp'),
    ];
    for (const p of candidates) {
        try { if (fs.existsSync(p)) { try { fs.chmodSync(p, '755'); } catch {} return p; } } catch {}
    }
    return 'yt-dlp';
}

function getDenoPath() {
    const home = process.env.HOME || '/root';
    const candidates = [
        path.join(home, '.deno', 'bin', 'deno'),
        '/usr/bin/deno',
        '/usr/local/bin/deno',
        '/snap/bin/deno',
        path.join(home, '.local', 'bin', 'deno'),
    ];
    for (const p of candidates) {
        try { if (fs.existsSync(p)) return p; } catch {}
    }
    return null;
}

const YT_DLP   = getYtDlpPath();
const DENO_PATH = getDenoPath();

const CHILD_ENV = (() => {
    const homeDirs = [
        process.env.HOME && path.join(process.env.HOME, '.local', 'bin'),
        process.env.HOME && path.join(process.env.HOME, '.deno', 'bin'),
        '/snap/bin', '/usr/local/bin', '/usr/bin', '/bin',
    ].filter(Boolean);
    const denoDir = DENO_PATH ? path.dirname(DENO_PATH) : null;
    const allDirs = denoDir ? [denoDir, ...homeDirs] : homeDirs;
    const merged  = [...new Set([...allDirs, ...(process.env.PATH || '').split(':')])].join(':');
    return { ...process.env, PATH: merged, HOME: process.env.HOME || '/root',
        DENO_DIR: process.env.DENO_DIR || path.join(process.env.HOME || '/root', '.deno'),
        ACOUSTID_KEY };
})();
function buildEnv() { return CHILD_ENV; }

// ─── Download strategies ───────────────────────────────────────────────────────

const DOWNLOAD_STRATEGIES = [
    { name: 'tv_embedded', extraArgs: ['--extractor-args', 'youtube:player_client=tv_embedded'], formatArg: 'bestaudio[ext=m4a]/bestaudio/best' },
    { name: 'ios',         extraArgs: ['--extractor-args', 'youtube:player_client=ios'],         formatArg: 'bestaudio[ext=m4a]/bestaudio/best' },
    { name: 'android_vr',  extraArgs: ['--extractor-args', 'youtube:player_client=android_vr'],  formatArg: 'bestaudio[ext=m4a]/bestaudio/best' },
];

function sharedArgs(isPlaylist = false) {
    return [
        '--no-check-certificate',
        isPlaylist ? '--yes-playlist' : '--no-playlist',
        '--no-warnings',
        '--socket-timeout', '15',
        '--retries', '3',
        '--fragment-retries', '3',
        '--retry-sleep', '2',
        '--concurrent-fragments', '4',
        '--buffer-size', '16K',
        ...(COOKIES_FILE ? ['--cookies', COOKIES_FILE] : []),
    ];
}

// ─── Build ffmpeg postprocessor args for single-pass tagging ─────────────────
// These are passed to yt-dlp's --postprocessor-args so ffmpeg embeds the tags
// during the SAME conversion step. Zero extra passes on slow hardware.
//
// yt-dlp syntax:  --postprocessor-args "ffmpeg:-metadata title=Foo -metadata artist=Bar"
// The leading "ffmpeg:" tells yt-dlp which postprocessor gets the args.

function buildTagPostprocessorArgs(metaTags) {
    if (!metaTags) return [];
    const parts = [];
    if (metaTags.title)  parts.push(`-metadata`, `title=${metaTags.title}`);
    if (metaTags.artist) parts.push(`-metadata`, `artist=${metaTags.artist}`);
    if (metaTags.album)  parts.push(`-metadata`, `album=${metaTags.album}`);
    if (metaTags.year)   parts.push(`-metadata`, `date=${metaTags.year}`);
    if (metaTags.genre)  parts.push(`-metadata`, `genre=${metaTags.genre}`);
    if (metaTags.track)  parts.push(`-metadata`, `track=${metaTags.track}`);
    if (parts.length === 0) return [];
    // Join as a single string for --postprocessor-args
    return ['--postprocessor-args', `ffmpeg:${parts.join(' ')}`];
}

// ─── Quality arg helper ───────────────────────────────────────────────────────
// Old code used a broken VBR formula for MP3. Now we use explicit CBR bitrates
// which are faster to encode on slow hardware and give predictable file sizes.
// WAV and M4A still need the ${quality}K form.

function buildQualityArg(audioFormat, quality) {
    switch (audioFormat) {
        case 'wav':
        case 'm4a':
            return `${quality}K`;
        case 'ogg': {
            // libvorbis quality is 0-10 (NOT kbps). Old code overflowed to 11 at 320kbps.
            const v = Math.round((quality - 128) / 48 * 2 + 3);
            return String(Math.min(10, Math.max(0, v)));
        }
        case 'mp3':
        default:
            // Use explicit CBR bitrate — fastest for low-power CPUs
            return `${quality}K`;
    }
}

// ─── Pipelined download + encode ─────────────────────────────────────────────
// yt-dlp stdout → ffmpeg stdin simultaneously.
// Encoding starts with the first arriving bytes — no post-download wait.

async function downloadAndEncodePiped(url, strategy, outputPath, ffmpegAudioArgs, isPreview, onProgress) {
    return new Promise((resolve, reject) => {
        const ytArgs = [
            ...strategy.extraArgs,
            '--no-check-certificate', '--no-playlist', '--no-warnings',
            '--socket-timeout', '15', '--retries', '3',
            '--concurrent-fragments', '4', '--buffer-size', '16K',
            ...(COOKIES_FILE ? ['--cookies', COOKIES_FILE] : []),
            '-f', 'bestaudio[ext=m4a]/bestaudio/best',
            ...(isPreview ? ['--download-sections', '*0-30', '--force-keyframes-at-cuts'] : []),
            '-o', '-', '--newline', url,
        ];
        const ffArgs = [
            '-hide_banner', '-loglevel', 'error',
            '-i', 'pipe:0', '-vn', '-threads', '1',
            ...ffmpegAudioArgs, '-y', outputPath,
        ];
        const ytdlp  = spawn(YT_DLP,  ytArgs, { env: CHILD_ENV });
        const ffmpeg = spawn('ffmpeg', ffArgs,  { env: CHILD_ENV });
        ytdlp.stdout.pipe(ffmpeg.stdin);

        let ytErr = '';
        ytdlp.stderr.on('data', d => {
            const t = d.toString(); ytErr += t;
            if (!onProgress) return;
            for (const line of t.split('\n').reverse()) {
                const m = line.match(/\[download\]\s+(\d+\.?\d*)%(?:.*?at\s+([\d.]+\s*\S+\/s))?(?:.*?ETA\s+(\S+))?/);
                if (m) { onProgress('download', parseFloat(m[1]), m[2]||null, m[3]||null); break; }
            }
        });
        let ffErr = '';
        ffmpeg.stderr.on('data', d => { ffErr += d.toString(); });

        ytdlp.on('close', code => {
            if (code !== 0) { ffmpeg.stdin.destroy(); ffmpeg.kill(); reject(new Error(ytErr.trim().split('\n').pop() || `yt-dlp ${code}`)); }
        });
        ffmpeg.on('close', code => {
            if (code === 0) resolve();
            else reject(new Error(`ffmpeg: ${ffErr.trim().split('\n').pop() || code}`));
        });
        ytdlp.on('error',  e => reject(new Error(`yt-dlp: ${e.message}`)));
        ffmpeg.on('error', e => reject(new Error(`ffmpeg: ${e.message}`)));
    });
}

// ─── Auto-update yt-dlp daily ─────────────────────────────────────────────────

function startYtDlpAutoUpdate() {
    const CHECK_INTERVAL = 24 * 60 * 60 * 1000;

    async function tryUpdate() {
        try {
            logger.info('Auto-update: checking yt-dlp...');
            const { stdout } = await execAsync(`"${YT_DLP}" -U 2>&1`, { timeout: 60000, env: buildEnv() });
            const result = stdout.trim().split('\n').pop();
            logger.success(`Auto-update yt-dlp: ${result}`);
        } catch (err) {
            logger.warn(`Auto-update yt-dlp failed: ${err.message.slice(0, 100)}`);
        }
    }

    setTimeout(() => {
        tryUpdate();
        setInterval(tryUpdate, CHECK_INTERVAL);
    }, 5 * 60 * 1000);
}

// ─── Dependency check ─────────────────────────────────────────────────────────

async function checkDependencies() {
    logger.divider('DEPENDENCY CHECK');

    try {
        const { stdout } = await execAsync(`"${YT_DLP}" --version`);
        const ver = stdout.trim();
        logger.info(`yt-dlp: ${YT_DLP}  (${ver})`);
        const m = ver.match(/(\d{4})\.(\d{2})\.(\d{2})/);
        if (m) {
            const date = Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
            if (date < 20251208) {
                logger.warn('yt-dlp outdated — many videos WILL fail. Run: sudo yt-dlp -U');
            } else {
                logger.success('yt-dlp version OK');
            }
        }
    } catch {
        logger.error(`yt-dlp not found.`);
    }

    if (DENO_PATH) {
        try {
            const { stdout } = await execAsync(`"${DENO_PATH}" --version 2>&1`);
            logger.success(`deno: ${DENO_PATH}  (${stdout.split('\n')[0].trim()})`);
        } catch {
            logger.warn(`deno found at ${DENO_PATH} but failed to run`);
        }
    } else {
        logger.warn('deno not found — nsig solving may fail.');
    }

    try {
        const { stdout } = await execAsync('ffmpeg -version 2>&1');
        logger.success(`ffmpeg: ${stdout.split('\n')[0].trim().substring(0, 60)}`);
    } catch {
        logger.error('ffmpeg not found.');
    }

    if (COOKIES_FILE) {
        logger.success(`cookies: ${COOKIES_FILE}`);
    } else {
        logger.warn('yt-cookies.txt not found — age-restricted videos may fail');
    }

    if (FPCALC_PATH) {
        logger.success(`fpcalc: ${FPCALC_PATH}`);
    } else {
        logger.warn('fpcalc not found — AcoustID disabled.');
    }

    if (ACOUSTID_KEY) {
        logger.success(`AcoustID: API key set (${ACOUSTID_KEY.substring(0, 6)}...)`);
    } else {
        logger.warn('ACOUSTID_KEY not set — auto-tagging disabled.');
    }

    logger.divider();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stripEmojis(str) {
    if (typeof str !== 'string') return str;
    return str
        .replace(/[\u{1F000}-\u{1FFFF}]/gu, ' ')
        .replace(/[\u{2300}-\u{27BF}]/gu,   ' ')
        .replace(/[\u{FE00}-\u{FE0F}]/gu,   '')
        .replace(/\u200D/g, '')
        .replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

function sanitizeFilename(filename) {
    if (typeof filename !== 'string' || !filename.trim()) return 'download';
    return filename
        .replace(/[\/\\:*?"<>|]/g, '')
        .replace(/\.{2,}/g, '.')
        .replace(/^[\s.]+|[\s.]+$/g, '')
        .substring(0, 200) || 'download';
}

function cleanYoutubeUrl(url) {
    if (typeof url !== 'string') return null;
    try {
        const u = new URL(url);
        if (!u.hostname.includes('youtu')) return null;
        return url;
    } catch { return null; }
}

function getMimeType(ext) {
    return { mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', zip: 'application/zip' }[ext]
        || 'application/octet-stream';
}

function isPlaylistUrl(url) {
    try {
        const u = new URL(url);
        return u.searchParams.has('list') && !u.searchParams.has('v');
    } catch { return false; }
}

// ─── Download queue ───────────────────────────────────────────────────────────

const queue = [];
let activeJobs = 0;

function enqueue(fn) {
    return new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject });
        drainQueue();
    });
}

function drainQueue() {
    while (activeJobs < QUEUE_CONCURRENCY && queue.length > 0) {
        const { fn, resolve, reject } = queue.shift();
        activeJobs++;
        fn()
            .then(resolve)
            .catch(reject)
            .finally(() => { activeJobs--; drainQueue(); });
    }
}

// ─── Download state ───────────────────────────────────────────────────────────

const activeDownloads = new Map();

function pruneActiveDownloads() {
    if (activeDownloads.size < 30) return;
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [id, job] of activeDownloads) {
        if ((job.complete || job.error) && job._ts && job._ts < cutoff) activeDownloads.delete(id);
    }
}
function updateDownloadStatus(id, updates) {
    const next = { ...(activeDownloads.get(id) || {}), ...updates };
    if (updates.complete || updates.error) next._ts = Date.now();
    activeDownloads.set(id, next);
    process.emit(`progress-${id}`, next);
    pruneActiveDownloads();
}

// ─── yt-dlp spawner ───────────────────────────────────────────────────────────

function spawnYtdlp(args, onProgress) {
    return new Promise((resolve, reject) => {
        logger.info(`Running: ${YT_DLP} ${args.join(' ')}`);

        const child = spawn(YT_DLP, args, { env: buildEnv() });
        let stderr = '';

        child.stdout.on('data', (data) => {
            if (!onProgress) return;
            const lines = data.toString().split('\n');
            for (const line of [...lines].reverse()) {
                const m = line.match(/\[download\]\s+(\d+\.?\d*)%(?:.*?at\s+([\d.]+\s*\S+\/s))?(?:.*?ETA\s+(\S+))?/);
                if (m) {
                    onProgress('download', parseFloat(m[1]), m[2] || null, m[3] || null);
                    break;
                }
                if (line.includes('Destination') || line.includes('Extracting') || line.includes('Converting')) {
                    onProgress('convert');
                    break;
                }
            }
        });

        child.stderr.on('data', (d) => {
            const t = d.toString().trim();
            stderr += t + '\n';
            console.log(`[YT-DLP-ERROR] ${t}`);
        });

        child.on('close', (code) => {
            if (code === 0) resolve();
            else {
                logger.error(`Process exited with code ${code}`);
                reject(new Error(`yt-dlp exited ${code}`));
            }
        });
    });
}

// ─── Simple HTTP GET helper ───────────────────────────────────────────────────

function httpGet(url, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const mod   = url.startsWith('https') ? https : http;
        const agent = url.startsWith('https') ? httpsAgent : undefined;
        const options = {
            timeout: timeoutMs,
            agent,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        };

        const req = mod.get(url, options, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            let body = '';
            res.on('data', d => body += d);
            res.on('end', () => {
                try { resolve(JSON.parse(body)); }
                catch { reject(new Error('Invalid JSON')); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
}

// ─── oEmbed fast fetch ────────────────────────────────────────────────────────

async function fetchVideoInfoFast(url) {
    const encoded = encodeURIComponent(url);
    const data    = await httpGet(
        `https://www.youtube.com/oembed?url=${encoded}&format=json`,
        2500
    );

    if (!data.title) throw new Error('oEmbed returned no title');

    const vidId = extractVideoId(url);
    const thumb = vidId
        ? `https://i.ytimg.com/vi/${vidId}/hqdefault.jpg`
        : (data.thumbnail_url || '');

    return {
        title:         stripEmojis(data.title),
        author:        stripEmojis(data.author_name || 'Unknown'),
        lengthSeconds: 0,
        thumbnailUrl:  thumb,
        fromOembed:    true,
    };
}

function extractVideoId(url) {
    try {
        const u = new URL(url);
        if (u.hostname.includes('youtu.be')) return u.pathname.slice(1).split('?')[0];
        return u.searchParams.get('v') || null;
    } catch { return null; }
}

// ─── Video info ───────────────────────────────────────────────────────────────

async function fetchVideoInfo(url) {
    try {
        const t0   = Date.now();
        const fast = await fetchVideoInfoFast(url);
        logger.info(`oEmbed hit: "${fast.title}" in ${Date.now() - t0}ms`);
        enrichDurationAsync(url, extractVideoId(url));
        return fast;
    } catch (oembedErr) {
        logger.warn(`oEmbed failed (${oembedErr.message}), falling back to yt-dlp`);
    }

    const t1 = Date.now();
    for (const strategy of DOWNLOAD_STRATEGIES) {
        try {
            const args = [...strategy.extraArgs, ...sharedArgs(), '--dump-json', url];
            const cmd  = `"${YT_DLP}" ${args.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`;
            const { stdout } = await execAsync(cmd, { maxBuffer: 10 * 1024 * 1024, timeout: 40000, env: buildEnv() });
            const info = JSON.parse(stdout);
            logger.info(`yt-dlp info took ${Date.now() - t1}ms via ${strategy.name}`);
            return {
                title:         stripEmojis(info.title    || 'Unknown Title'),
                author:        stripEmojis(info.uploader || info.channel || 'Unknown'),
                lengthSeconds: parseInt(info.duration    || '0'),
                thumbnailUrl:  info.thumbnail || '',
                fromOembed:    false,
            };
        } catch (err) {
            logger.warn(`Info strategy "${strategy.name}" failed: ${err.message.slice(0, 150)}`);
        }
    }
    throw new Error('All strategies failed to fetch video info');
}

const durationCache = new Map();

async function enrichDurationAsync(url, videoId) {
    if (!videoId) return;
    if (durationCache.has(videoId)) return;
    try {
        const cmd = `"${YT_DLP}" --no-playlist --no-warnings --retries 1 --socket-timeout 8 --extractor-args "youtube:player_client=tv_embedded" --print duration "${url}"`;
        const { stdout } = await execAsync(cmd, { timeout: 12000, env: buildEnv() });
        const secs = parseInt(stdout.trim());
        if (!isNaN(secs) && secs > 0) {
            durationCache.set(videoId, secs);
            logger.info(`Duration cached: ${videoId} = ${secs}s`);
        }
    } catch {}
}

// ─── AcoustID audio fingerprinting ───────────────────────────────────────────
// Uses -c copy so it's just a container re-wrap with new tags — extremely fast
// even on an i3-6006U. No re-encoding.

let acoustidFailCount = 0;

async function autoTagWithAcoustID(filePath, downloadId) {
    if (!FPCALC_PATH) { logger.warn(`[${downloadId}] AcoustID: fpcalc not found`); return null; }
    if (acoustidFailCount >= 2) {
        logger.warn(`[${downloadId}] AcoustID circuit open (bad key — fix ACOUSTID_KEY)`);
        return null;
    }

    try {
        updateDownloadStatus(downloadId, { status: 'Identifying track...', progress: 97 });

        const { stdout: fpcOut } = await execAsync(
            `"${FPCALC_PATH}" -json "${filePath}"`,
            { timeout: 30000 }
        );
        const fpc = JSON.parse(fpcOut);
        if (!fpc.fingerprint || !fpc.duration) throw new Error('fpcalc returned no fingerprint');

        const acoustUrl = `https://api.acoustid.org/v2/lookup?client=${ACOUSTID_KEY}` +
            `&meta=recordings+releasegroups+compress` +
            `&duration=${Math.round(fpc.duration)}` +
            `&fingerprint=${encodeURIComponent(fpc.fingerprint)}`;

        const result = await httpGet(acoustUrl, 8000);
        if (result.status !== 'ok' || !result.results?.length) throw new Error('No AcoustID results');

        const best = result.results
            .filter(r => r.score > 0.75 && r.recordings?.length)
            .sort((a, b) => b.score - a.score)[0];

        if (!best) throw new Error(`No confident match`);

        const rec    = best.recordings[0];
        const title  = rec.title   || '';
        const artist = rec.artists?.[0]?.name || '';
        const album  = rec.releasegroups?.[0]?.title || '';
        const year   = rec.releasegroups?.[0]?.['first-release-date']?.slice(0, 4) || '';

        if (!title && !artist) throw new Error('No usable metadata');

        acoustidFailCount = 0;
        logger.success(`[${downloadId}] AcoustID: "${artist} - ${title}" (score: ${best.score.toFixed(2)})`);

        // Rewrite tags with -c copy (no re-encode, < 1s on any file size).
        // Use spawn instead of exec so metadata values with spaces are passed
        // as proper argv entries — the old execAsync shell-string approach
        // broke on titles like "My Song" (split at the space).
        const taggedPath = filePath + '.acoustid.mp3';
        await new Promise((resolve, reject) => {
            const args = [
                '-y', '-i', filePath,
                '-c:a', 'copy',
                ...(title  ? ['-metadata', `title=${title}`]   : []),
                ...(artist ? ['-metadata', `artist=${artist}`] : []),
                ...(album  ? ['-metadata', `album=${album}`]   : []),
                ...(year   ? ['-metadata', `date=${year}`]     : []),
                taggedPath,
            ];
            const proc = spawn('ffmpeg', args, { env: CHILD_ENV || buildEnv() });
            let stderr = '';
            proc.stderr.on('data', d => { stderr += d.toString(); });
            proc.on('close', code => {
                if (code === 0) resolve();
                else reject(new Error(stderr.trim().split('\n').pop() || `ffmpeg exited ${code}`));
            });
            proc.on('error', reject);
        });
        fs.renameSync(taggedPath, filePath);

        logger.success(`[${downloadId}] AcoustID tags written: "${artist} - ${title}"`);
        return { title, artist, album, year, score: best.score };

    } catch (err) {
        if (err.message.includes('HTTP 400')) {
            acoustidFailCount++;
            logger.warn(`[${downloadId}] AcoustID HTTP 400 (bad key) — strike ${acoustidFailCount}/2`);
        } else {
            logger.warn(`[${downloadId}] AcoustID: ${err.message}`);
        }
        return null;
    }
}

async function fetchPlaylistInfo(url) {
    for (const strategy of DOWNLOAD_STRATEGIES) {
        try {
            const args = [
                ...strategy.extraArgs,
                ...sharedArgs(true),
                '--dump-json',
                '--flat-playlist',
                url,
            ];
            const cmd = `"${YT_DLP}" ${args.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`;
            const { stdout } = await execAsync(cmd, { maxBuffer: 20 * 1024 * 1024, timeout: 60000, env: buildEnv() });
            const entries = stdout.trim().split('\n').map(line => {
                try { return JSON.parse(line); } catch { return null; }
            }).filter(Boolean);
            return entries;
        } catch (err) {
            logger.warn(`Playlist info strategy "${strategy.name}" failed: ${err.message.slice(0, 150)}`);
        }
    }
    throw new Error('All strategies failed to fetch playlist info');
}

// ─── Single track download ────────────────────────────────────────────────────
// KEY OPTIMIZATION: metadata tags are now injected via --postprocessor-args
// so yt-dlp embeds them during the same ffmpeg conversion pass that creates
// the audio file. Previously there was a SECOND ffmpeg call after the fact,
// which doubled the encoding time on slow hardware.

async function processYoutubeDownload(url, downloadId, audioFormat = 'mp3', quality = 192, outputFilename, isPreview = false, embedThumbnail = false, metaTags = null) {
    let finalOutputPath = null;
    try {
        updateDownloadStatus(downloadId, { status: isPreview ? 'Generating preview...' : 'Initializing...', progress: 5 });

        const formatMap = { ogg: 'vorbis', m4a: 'aac' };
        const conversionFormat = formatMap[audioFormat] || audioFormat;

        let filename = sanitizeFilename(outputFilename || 'download');
        const extRe = new RegExp(`\.${audioFormat}$`, 'i');
        if (!extRe.test(filename)) filename = filename.replace(/\.[^/.]+$/, '') + '.' + audioFormat;

        finalOutputPath = path.join(MP3_STORAGE_PATH, filename);
        const qualityArg = buildQualityArg(audioFormat, quality);

        let lastProgress = 0;
        const onProgress = (type, pct, speed, eta) => {
            if (type === 'download' && pct !== undefined) {
                const calc = 10 + Math.floor(pct * 0.85);
                if (calc > lastProgress) {
                    lastProgress = calc;
                    updateDownloadStatus(downloadId, {
                        status:   `Downloading: ${Math.floor(pct)}%`,
                        progress: lastProgress, speed: speed||null, eta: eta||null,
                    });
                }
            } else if (type === 'convert' && lastProgress < 95) {
                lastProgress = 95;
                updateDownloadStatus(downloadId, { status: 'Finalizing...', progress: 95, speed: null, eta: null });
            }
        };

        // ── Format routing ──────────────────────────────────────────────────
        //  mp3, wav  → pipe: simultaneous download+encode, no wait after dl
        //  m4a       → yt-dlp postprocessor: native aac remux, near-instant
        //  ogg       → yt-dlp postprocessor: libvorbis (quality 0-10, fixed)
        //  any + embedThumbnail → yt-dlp postprocessor (needs its own chain)

        const usePipe = (audioFormat === 'mp3' || audioFormat === 'wav') && !embedThumbnail;

        if (usePipe) {
            const metaParts = [];
            if (metaTags && !isPreview) {
                if (metaTags.title)  metaParts.push('-metadata', `title=${metaTags.title}`);
                if (metaTags.artist) metaParts.push('-metadata', `artist=${metaTags.artist}`);
                if (metaTags.album)  metaParts.push('-metadata', `album=${metaTags.album}`);
                if (metaTags.year)   metaParts.push('-metadata', `date=${metaTags.year}`);
                if (metaTags.genre)  metaParts.push('-metadata', `genre=${metaTags.genre}`);
                if (metaTags.track)  metaParts.push('-metadata', `track=${metaTags.track}`);
            }
            const ffmpegAudioArgs = audioFormat === 'mp3'
                ? ['-c:a', 'libmp3lame', '-b:a', `${quality}k`, ...metaParts]
                : ['-c:a', 'pcm_s16le', ...metaParts];

            let succeeded = false, lastError = null;
            for (const strategy of DOWNLOAD_STRATEGIES) {
                logger.info(`[${downloadId}] trying (pipe/${audioFormat}): ${strategy.name}`);
                try {
                    if (fs.existsSync(finalOutputPath)) fs.unlinkSync(finalOutputPath);
                    await downloadAndEncodePiped(url, strategy, finalOutputPath, ffmpegAudioArgs, isPreview, onProgress);
                    succeeded = true;
                    logger.success(`[${downloadId}] pipe "${strategy.name}" succeeded`);
                    break;
                } catch (err) {
                    lastError = err;
                    logger.warn(`[${downloadId}] pipe "${strategy.name}" failed: ${err.message.slice(0,200)}`);
                    if (fs.existsSync(finalOutputPath)) try { fs.unlinkSync(finalOutputPath); } catch {}
                }
            }
            if (!succeeded) throw lastError || new Error('All pipe strategies failed');

        } else {
            const tempPattern = path.join(MP3_STORAGE_PATH, `temp_${downloadId}.%(ext)s`);
            const tagArgs = (metaTags && !isPreview) ? buildTagPostprocessorArgs(metaTags) : [];

            let succeeded = false, lastError = null;
            for (const strategy of DOWNLOAD_STRATEGIES) {
                logger.info(`[${downloadId}] trying: ${strategy.name}`);
                try {
                    const stale = fs.readdirSync(MP3_STORAGE_PATH).filter(f => f.startsWith(`temp_${downloadId}`));
                    for (const f of stale) try { fs.unlinkSync(path.join(MP3_STORAGE_PATH, f)); } catch {}
                } catch {}
                const args = [
                    ...strategy.extraArgs, ...sharedArgs(),
                    '-f', strategy.formatArg,
                    '--extract-audio', '--audio-format', conversionFormat,
                    '--audio-quality', qualityArg, '--newline',
                    ...(isPreview ? ['--download-sections', '*0-30', '--force-keyframes-at-cuts'] : []),
                    ...(embedThumbnail ? ['--embed-thumbnail', '--convert-thumbnails', 'jpg'] : []),
                    ...tagArgs, '-o', tempPattern, url,
                ];
                try {
                    await spawnYtdlp(args, onProgress);
                    succeeded = true;
                    logger.success(`[${downloadId}] strategy "${strategy.name}" succeeded`);
                    break;
                } catch (err) {
                    lastError = err;
                    logger.warn(`[${downloadId}] strategy "${strategy.name}" failed: ${err.message.slice(0,200)}`);
                }
            }
            if (!succeeded) throw lastError || new Error('All download strategies failed');

            const tmpFile = fs.readdirSync(MP3_STORAGE_PATH).find(f => f.startsWith(`temp_${downloadId}`));
            if (!tmpFile) throw new Error('Output file not generated by yt-dlp.');
            const tmpPath = path.join(MP3_STORAGE_PATH, tmpFile);
            if (fs.existsSync(finalOutputPath)) fs.unlinkSync(finalOutputPath);
            fs.renameSync(tmpPath, finalOutputPath);
        }


        const stat = fs.statSync(finalOutputPath);
        if (stat.size === 0) throw new Error('Converted file is empty.');

        // AcoustID auto-tag — only runs when no manual tags were provided.
        // Uses -c copy so it's < 1 second regardless of file size.
        let acoustidMatch = null;
        if (audioFormat === 'mp3' && !isPreview && !metaTags) {
            acoustidMatch = await autoTagWithAcoustID(finalOutputPath, downloadId);
        }

        registerFile(finalOutputPath);
        logger.success(`Ready: ${filename} (${(stat.size / 1048576).toFixed(2)} MB) — expires in 1h`);

        updateDownloadStatus(downloadId, {
            status:       'Done!',
            progress:     100,
            complete:     true,
            downloadUrl:  `${BASE_PATH}/downloads/${encodeURIComponent(filename)}`,
            filename,
            expiresAt:    Date.now() + FILE_TTL_MS,
            acoustid:     acoustidMatch || undefined,
        });

    } catch (err) {
        logger.error(`Download failed [${downloadId}]: ${err.message}`);

        let userMessage = `Failed: ${err.message}`;
        if (err.message.includes('nsig') || err.message.includes('n challenge')) {
            userMessage = 'Failed: deno required. Install: curl -fsSL https://deno.land/install.sh | sh';
        } else if (err.message.includes('403')) {
            userMessage = 'Failed: HTTP 403. Update yt-dlp: sudo yt-dlp -U';
        } else if (err.message.includes('not available') || err.message.includes('SABR')) {
            userMessage = 'Failed: YouTube SABR blocking. Update yt-dlp to 2025.12.08+ and install deno.';
        }

        updateDownloadStatus(downloadId, { error: true, status: userMessage, complete: true });

        try {
            const stale = fs.readdirSync(MP3_STORAGE_PATH).filter(f => f.startsWith(`temp_${downloadId}`));
            for (const f of stale) fs.unlinkSync(path.join(MP3_STORAGE_PATH, f));
        } catch {}
        if (finalOutputPath && fs.existsSync(finalOutputPath)) {
            try { fs.unlinkSync(finalOutputPath); } catch {}
        }
    }
}

// ─── Playlist download ────────────────────────────────────────────────────────

async function processPlaylistDownload(url, downloadId, audioFormat = 'mp3', quality = 192, embedThumbnail = false) {
    const formatMap = { ogg: 'vorbis', m4a: 'aac' };
    const conversionFormat = formatMap[audioFormat] || audioFormat;
    const qualityArg = buildQualityArg(audioFormat, quality);

    let zipPath = null;
    try {
        updateDownloadStatus(downloadId, { status: 'Fetching playlist info...', progress: 3, isPlaylist: true });

        const entries = await fetchPlaylistInfo(url);
        const total = entries.length;
        if (total === 0) throw new Error('Playlist is empty or unavailable.');

        const playlistTitle = sanitizeFilename(entries[0]?.playlist_title || entries[0]?.playlist || 'playlist');
        const tempDir = path.join(MP3_STORAGE_PATH, `playlist_${downloadId}`);
        fs.mkdirSync(tempDir, { recursive: true });

        updateDownloadStatus(downloadId, {
            status: `Downloading playlist: ${total} tracks`,
            progress: 5,
            total,
            done: 0,
        });

        let doneCount = 0;

        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            const videoUrl = entry.url || entry.webpage_url || `https://www.youtube.com/watch?v=${entry.id}`;
            const trackName = sanitizeFilename(entry.title || `track_${i + 1}`);
            const outPattern = path.join(tempDir, `${String(i + 1).padStart(3, '0')}_${trackName}.%(ext)s`);

            updateDownloadStatus(downloadId, {
                status: `[${i+1}/${total}] ${trackName}`,
                progress: 5 + Math.floor((i / total) * 88),
                done: i,
                total,
            });

            // Build single-pass tag args for each playlist track
            const artistName = stripEmojis(entry.uploader || entry.channel || playlistTitle);
            const trackTagArgs = audioFormat === 'mp3' ? buildTagPostprocessorArgs({
                title:  trackName,
                artist: artistName,
                album:  playlistTitle,
                track:  `${i + 1}/${total}`,
            }) : [];

            let trackSucceeded = false;
            for (const strategy of DOWNLOAD_STRATEGIES) {
                const args = [
                    ...strategy.extraArgs,
                    ...sharedArgs(),
                    '-f', strategy.formatArg,
                    '--extract-audio',
                    '--audio-format', conversionFormat,
                    '--audio-quality', qualityArg,
                    '--newline',
                    ...(embedThumbnail && audioFormat === 'mp3' ? ['--embed-thumbnail', '--convert-thumbnails', 'jpg'] : []),
                    ...trackTagArgs,   // <-- SINGLE-PASS TAGS
                    '-o', outPattern,
                    videoUrl,
                ];
                try {
                    await spawnYtdlp(args, null);
                    trackSucceeded = true;
                    break;
                } catch {}
            }

            if (!trackSucceeded) {
                logger.warn(`Playlist track ${i+1} failed, skipping: ${videoUrl}`);
            }

            doneCount++;
        }

        updateDownloadStatus(downloadId, { status: 'Creating zip...', progress: 95 });

        const zipName = `${playlistTitle}.zip`;
        zipPath = path.join(MP3_STORAGE_PATH, zipName);
        await execAsync(`cd "${tempDir}" && zip -r "${zipPath}" .`, { timeout: 120000 });

        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}

        const stat = fs.statSync(zipPath);
        if (stat.size === 0) throw new Error('Zip file is empty.');

        registerFile(zipPath);
        logger.success(`Playlist ready: ${zipName} (${(stat.size / 1048576).toFixed(2)} MB) — expires in 1h`);

        updateDownloadStatus(downloadId, {
            status: 'Playlist ready!',
            progress: 100,
            complete: true,
            downloadUrl: `${BASE_PATH}/downloads/${encodeURIComponent(zipName)}`,
            filename: zipName,
            expiresAt: Date.now() + FILE_TTL_MS,
            isPlaylist: true,
            done: doneCount,
            total,
        });

    } catch (err) {
        logger.error(`Playlist download failed [${downloadId}]: ${err.message}`);
        updateDownloadStatus(downloadId, { error: true, status: `Failed: ${err.message}`, complete: true });
        try {
            const tempDir = path.join(MP3_STORAGE_PATH, `playlist_${downloadId}`);
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {}
        if (zipPath && fs.existsSync(zipPath)) try { fs.unlinkSync(zipPath); } catch {}
    }
}

// ─── Fastify ──────────────────────────────────────────────────────────────────

const fastify = require('fastify')({
    trustProxy: true,
    logger: false,
    bodyLimit: 1048576,
    requestTimeout: 300000,
    keepAliveTimeout: 30000,
});

fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    try { done(null, JSON.parse(body)); } catch (e) { done(e, undefined); }
});

fastify.register(require('@fastify/cors'), {
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    credentials: true,
});

// ─── Rate limiting ────────────────────────────────────────────────────────────

const rateLimitCache = new Map();

fastify.addHook('onRequest', (request, reply, done) => {
    if (/\.(css|js|png|jpg|ico|svg)$/.test(request.url)) return done();

    const ip  = request.ip;
    const now = Date.now();

    if (rateLimitCache.size > 200) {
        for (const [k, v] of rateLimitCache)
            if (now - v.timestamp > TIME_WINDOW) rateLimitCache.delete(k);
    }

    const rec = rateLimitCache.get(ip) || { count: 0, timestamp: now };
    if (now - rec.timestamp >= TIME_WINDOW) { rec.count = 0; rec.timestamp = now; }
    if (rec.count >= MAX_REQUESTS) {
        return reply.status(429).send({ error: 'Rate limit exceeded', retryAfter: Math.ceil((rec.timestamp + TIME_WINDOW - now) / 1000) });
    }
    rec.count++;
    rateLimitCache.set(ip, rec);
    done();
});

// ─── Auth middleware ──────────────────────────────────────────────────────────

function requireAuth(request, reply) {
    const key = request.headers['x-api-key'] || request.query._k;
    if (!key || key !== API_KEY) {
        reply.status(401).send({ error: 'Unauthorized' });
        return false;
    }
    return true;
}

// ─── Static routes ────────────────────────────────────────────────────────────

fastify.get('/', async (req, reply) => {
    try {
        return reply.type('text/html').send(await fs.promises.readFile(path.join(WEB_ROOT, 'index.html')));
    } catch { return reply.status(404).send('UI Not Found'); }
});

fastify.get('/style.css', async (req, reply) => {
    try { return reply.type('text/css').send(await fs.promises.readFile(path.join(WEB_ROOT, 'style.css'))); }
    catch { return reply.status(404).send(''); }
});

fastify.get('/cloud.png', async (req, reply) => {
    try { return reply.type('image/png').send(await fs.promises.readFile(path.join(WEB_ROOT, 'cloud.png'))); }
    catch { return reply.status(404).send(''); }
});

fastify.get('/favicon.ico', async (req, reply) => {
    try { return reply.type('image/x-icon').send(await fs.promises.readFile(path.join(WEB_ROOT, 'favicon.ico'))); }
    catch { return reply.status(404).send(''); }
});

fastify.get('/favicon.svg', async (req, reply) => {
    try { return reply.type('image/svg+xml').send(await fs.promises.readFile(path.join(WEB_ROOT, 'favicon.svg'))); }
    catch { return reply.status(404).send(''); }
});

fastify.get('/favicon-192.png', async (req, reply) => {
    try { return reply.type('image/png').send(await fs.promises.readFile(path.join(WEB_ROOT, 'favicon-192.png'))); }
    catch { return reply.status(404).send(''); }
});

fastify.get('/favicon-512.png', async (req, reply) => {
    try { return reply.type('image/png').send(await fs.promises.readFile(path.join(WEB_ROOT, 'favicon-512.png'))); }
    catch { return reply.status(404).send(''); }
});

fastify.get('/manifest.json', async (req, reply) => {
    try { return reply.type('application/manifest+json').send(await fs.promises.readFile(path.join(WEB_ROOT, 'manifest.json'))); }
    catch { return reply.status(404).send(''); }
});

fastify.get('/script.js', async (req, reply) => {
    try { return reply.type('application/javascript').send(await fs.promises.readFile(path.join(WEB_ROOT, 'script.js'))); }
    catch { return reply.status(404).send(''); }
});

fastify.get('/api/client-key', async (req, reply) => {
    return reply.send({ key: API_KEY });
});

fastify.get('/vendor/fa/all.min.css', async (req, reply) => {
    try { return reply.type('text/css').send(await fs.promises.readFile(path.join(WEB_ROOT, 'vendor/fa/all.min.css'))); }
    catch { return reply.status(404).send(''); }
});

fastify.get('/vendor/fa/webfonts/:file', async (req, reply) => {
    try {
        const file = path.basename(req.params.file);
        return reply.type('font/woff2').send(await fs.promises.readFile(path.join(WEB_ROOT, 'vendor/fa/webfonts', file)));
    } catch { return reply.status(404).send(''); }
});

fastify.get('/vendor/fonts/fonts.css', async (req, reply) => {
    try { return reply.type('text/css').send(await fs.promises.readFile(path.join(WEB_ROOT, 'vendor/fonts/fonts.css'))); }
    catch { return reply.status(404).send(''); }
});

fastify.get('/vendor/fonts/:file', async (req, reply) => {
    try {
        const file = path.basename(req.params.file);
        return reply.type('font/woff2').send(await fs.promises.readFile(path.join(WEB_ROOT, 'vendor/fonts', file)));
    } catch { return reply.status(404).send(''); }
});

// ─── API routes ───────────────────────────────────────────────────────────────

fastify.get('/api/video-info', async (req, reply) => {
    if (!requireAuth(req, reply)) return;

    const { url } = req.query;
    if (!url) return reply.status(400).send({ error: 'Missing URL' });

    const cleanUrl = cleanYoutubeUrl(url);
    if (!cleanUrl) return reply.status(400).send({ error: 'Invalid YouTube URL' });

    try {
        logger.info(`Fetching info: ${cleanUrl}`);

        if (isPlaylistUrl(cleanUrl)) {
            const entries = await fetchPlaylistInfo(cleanUrl);
            return reply.send({
                isPlaylist:   true,
                title:        entries[0]?.playlist_title || entries[0]?.playlist || 'Playlist',
                count:        entries.length,
                thumbnailUrl: entries[0]?.thumbnails?.slice(-1)[0]?.url || '',
            });
        }

        const info = await fetchVideoInfo(cleanUrl);
        return reply.send({
            isPlaylist:    false,
            title:         info.title,
            author:        info.author,
            lengthSeconds: info.lengthSeconds,
            thumbnailUrl:  info.thumbnailUrl,
            fromOembed:    info.fromOembed || false,
            videoId:       extractVideoId(cleanUrl),
        });
    } catch (err) {
        logger.error('video-info failed:', err.message);
        return reply.status(500).send({ error: 'Failed to fetch info', message: err.message });
    }
});

fastify.get('/api/video-duration/:videoId', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const { videoId } = req.params;
    const secs = durationCache.get(videoId);
    if (secs === undefined) return reply.status(404).send({ error: 'Not ready yet' });
    return reply.send({ lengthSeconds: secs });
});

fastify.get('/api/download', async (req, reply) => {
    if (!requireAuth(req, reply)) return;

    // FIX: Accept both 'embedThumb' (client sends) and 'embedThumbnail' (old name)
    const {
        url,
        format = 'mp3',
        quality = '192',
        preview,
        embedThumb,
        embedThumbnail,
        metaTitle,
        metaArtist,
        metaAlbum,
        metaYear,
        metaGenre,
        metaTrack,
        filename: customFilename,
    } = req.query;

    if (!url) return reply.status(400).send({ error: 'Missing URL' });

    if (!isValidYouTubeUrl(url)) {
        logger.warn(`Rejected invalid URL: ${url}`);
        return reply.status(400).send({ error: 'Bro, nice try. Valid YouTube URLs only.' });
    }

    const cleanUrl = cleanYoutubeUrl(url);
    if (!cleanUrl) return reply.status(400).send({ error: 'Invalid YouTube URL' });

    const id = uuidv4();
    const isPlaylist = isPlaylistUrl(cleanUrl);

    let outputFilename = customFilename;

    // --- SMART CACHE LOGIC ---
    let fileHash = null;
    if (!isPlaylist) {
        fileHash = crypto.createHash('md5').update(`${cleanUrl}-${format}-${quality}`).digest('hex');
        const cachedFilePath = path.join(CACHE_DIR, `${fileHash}.${format}`);

        if (fs.existsSync(cachedFilePath)) {
            logger.success(`[CACHE HIT] ${fileHash}`);

            const displayTitle = customFilename || `Download_${id.substring(0,6)}`;
            const finalFilename = sanitizeFilename(displayTitle) + `.${format}`;
            const finalPath = path.join(MP3_STORAGE_PATH, finalFilename);

            await fs.promises.copyFile(cachedFilePath, finalPath);

            // Renew the TTL — same link requested again resets the 1h clock
            registerFile(finalPath);

            const newExpiresAt = Date.now() + FILE_TTL_MS;
            activeDownloads.set(id, {
                status:      'Ready (cached)',
                progress:    100,
                complete:    true,
                filename:    finalFilename,
                downloadUrl: `${BASE_PATH}/downloads/${encodeURIComponent(finalFilename)}`,
                expiresAt:   newExpiresAt,
                cached:      true,
            });

            return reply.send({ id, isPlaylist: false, cached: true });
        }
    }

    const isPreview   = preview === '1';
    // Accept both param names (embedThumb from new client, embedThumbnail from old)
    const doEmbedThumb = (embedThumb === '1' || embedThumbnail === '1');

    // FIX: Build metaTags from query params — this is what was silently failing before.
    // The old code checked req.query correctly but the client wasn't sending the params
    // through properly because of a mismatch in the URLSearchParams key names.
    const metaTags = (metaTitle || metaArtist || metaAlbum || metaYear || metaGenre || metaTrack)
        ? {
            title:  metaTitle  || null,
            artist: metaArtist || null,
            album:  metaAlbum  || null,
            year:   metaYear   || null,
            genre:  metaGenre  || null,
            track:  metaTrack  || null,
          }
        : null;

    if (metaTags) {
        logger.info(`[${id}] Meta tags received: ${JSON.stringify(metaTags)}`);
    }

    activeDownloads.set(id, { status: 'Queued', progress: 0, isPlaylist });

    if (isPlaylist) {
        enqueue(() => processPlaylistDownload(cleanUrl, id, format || 'mp3', parseInt(quality) || 192, doEmbedThumb))
            .catch(err => logger.error('Unhandled playlist error:', err));
    } else {
        enqueue(() => processYoutubeDownload(cleanUrl, id, format || 'mp3', parseInt(quality) || 192, outputFilename, isPreview, doEmbedThumb, metaTags))
            .then(() => {
                if (fileHash) {
                    const job = activeDownloads.get(id);
                    if (job && job.filename) {
                        const originalPath = path.join(MP3_STORAGE_PATH, job.filename);
                        const cachedFilePath = path.join(CACHE_DIR, `${fileHash}.${format}`);
                        if (fs.existsSync(originalPath)) {
                            fs.copyFileSync(originalPath, cachedFilePath);
                        }
                    }
                }
            })
            .catch(err => logger.error('Unhandled download error:', err));
    }

    return reply.send({ id, isPlaylist });
});

fastify.get('/api/download-status/:id', async (req, reply) => {
    const { id } = req.params;
    if (!requireAuth(req, reply)) return;
    if (!activeDownloads.has(id)) return reply.status(404).send({ error: 'Not found' });
    return reply.send(activeDownloads.get(id));
});

fastify.get('/api/download-progress/:id', (req, reply) => {
    const { id } = req.params;
    if (!requireAuth(req, reply)) return;

    reply.raw.writeHead(200, {
        'Content-Type':      'text/event-stream',
        'Cache-Control':     'no-cache',
        'Connection':        'keep-alive',
        'X-Accel-Buffering': 'no',
    });

    const send = (data) => { try { reply.raw.write(`data: ${JSON.stringify(data)}\n\n`); } catch {} };

    if (activeDownloads.has(id)) {
        const cur = activeDownloads.get(id);
        send(cur);
        if (cur.complete || cur.error) { reply.raw.end(); return; }
    }

    const listener = (data) => {
        send(data);
        if (data.complete || data.error) {
            process.removeListener(`progress-${id}`, listener);
            try { reply.raw.end(); } catch {}
        }
    };

    process.on(`progress-${id}`, listener);
    req.raw.on('close', () => process.removeListener(`progress-${id}`, listener));
});

fastify.get('/downloads/:filename', async (req, reply) => {
    if (!requireAuth(req, reply)) return;

    const safeName = path.basename(decodeURIComponent(req.params.filename));
    const filePath = path.join(MP3_STORAGE_PATH, safeName);

    logger.info(`Serve: ${safeName}`);

    try {
        await fs.promises.access(filePath, fs.constants.R_OK);
        const stat = await fs.promises.stat(filePath);
        if (stat.size === 0) return reply.status(500).send('File conversion failed (empty).');

        const ext      = path.extname(safeName).replace('.', '').toLowerCase();
        const mimeType = getMimeType(ext);

        const expiresAt  = fileRegistry.get(safeName);
        const remaining  = expiresAt ? Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)) : null;

        reply.header('Content-Length', stat.size);
        reply.header('Content-Type', mimeType);
        reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(safeName)}"`);
        reply.header('Accept-Ranges', 'bytes');
        if (remaining !== null) reply.header('X-Expires-In', `${remaining}s`);

        const stream = fs.createReadStream(filePath);
        stream.on('error', (e) => { logger.error(`Stream error: ${e.message}`); try { reply.raw.end(); } catch {} });
        return reply.send(stream);

    } catch (err) {
        logger.error(`File not found: ${safeName} — ${err.message}`);
        return reply.status(404).send('File not found or has expired. Please try again.');
    }
});

// ─── Batch zip endpoint ───────────────────────────────────────────────────────

fastify.post('/api/batch-zip', async (req, reply) => {
    if (!requireAuth(req, reply)) return;

    const { urls, format, quality } = req.body || {};
    if (!Array.isArray(urls) || urls.length === 0)
        return reply.status(400).send({ error: 'No URLs provided' });

    const id = uuidv4();
    activeDownloads.set(id, { status: 'Queued', progress: 0, isBatch: true, total: urls.length, done: 0 });
    reply.send({ id });

    // Batch runs outside the main download queue — it manages its own concurrency
    // internally and shouldn't block single-track downloads for minutes at a time.
    processBatchZip(urls, id, format || 'mp3', parseInt(quality) || 192)
        .catch(err => logger.error('Unhandled batch-zip error:', err));
});

async function processBatchZip(urls, downloadId, audioFormat, quality) {
    const formatMap      = { ogg: 'vorbis', m4a: 'aac' };
    const conversionFormat = formatMap[audioFormat] || audioFormat;
    const qualityArg     = buildQualityArg(audioFormat, quality);
    const usePipe        = (audioFormat === 'mp3' || audioFormat === 'wav');

    // Each batch gets its own stable directory — survives restarts until TTL expires
    const batchDir  = path.join(MP3_STORAGE_PATH, `batch_${downloadId}`);
    const zipName   = `batch_${downloadId.substring(0, 8)}.zip`;
    const zipPath   = path.join(MP3_STORAGE_PATH, zipName);

    try {
        fs.mkdirSync(batchDir, { recursive: true });
        const total    = urls.length;
        let doneCount  = 0;
        let failCount  = 0;

        for (let i = 0; i < total; i++) {
            const cleanUrl = cleanYoutubeUrl(urls[i]);
            if (!cleanUrl) { doneCount++; continue; }

            updateDownloadStatus(downloadId, {
                status:   `[${i+1}/${total}] Downloading...`,
                progress: 5 + Math.floor((i / total) * 85),
                done: i, total,
            });

            // Use yt-dlp's %(title)s template directly — avoids a separate oEmbed
            // fetch per track (was adding 300-500ms * N to total time).
            const outPattern = path.join(batchDir,
                `${String(i + 1).padStart(3, '0')}_%(title)s.%(ext)s`);

            let succeeded = false;

            if (usePipe) {
                // Pipe path for mp3/wav: encode while downloading
                const ffmpegAudioArgs = audioFormat === 'mp3'
                    ? ['-c:a', 'libmp3lame', '-b:a', `${quality}k`]
                    : ['-c:a', 'pcm_s16le'];

                // For pipe we need a concrete output filename — use padded index
                // and rename after if needed. yt-dlp can't give us the title
                // before downloading when using pipe mode.
                const pipeDest = path.join(batchDir,
                    `${String(i + 1).padStart(3, '0')}_track.${audioFormat}`);

                for (const strategy of DOWNLOAD_STRATEGIES) {
                    try {
                        if (fs.existsSync(pipeDest)) fs.unlinkSync(pipeDest);
                        await downloadAndEncodePiped(cleanUrl, strategy, pipeDest, ffmpegAudioArgs, false, null);
                        // Try to rename using yt-dlp title after the fact via oEmbed (non-blocking best-effort)
                        fetchVideoInfoFast(cleanUrl).then(info => {
                            if (info?.title) {
                                const proper = path.join(batchDir,
                                    `${String(i + 1).padStart(3, '0')}_${sanitizeFilename(stripEmojis(info.title))}.${audioFormat}`);
                                try { if (fs.existsSync(pipeDest)) fs.renameSync(pipeDest, proper); } catch {}
                            }
                        }).catch(() => {});
                        succeeded = true;
                        break;
                    } catch (e) {
                        logger.warn(`Batch [${i+1}] pipe "${strategy.name}" failed: ${e.message.slice(0,120)}`);
                        if (fs.existsSync(pipeDest)) try { fs.unlinkSync(pipeDest); } catch {}
                    }
                }
            } else {
                // Standard yt-dlp postprocessor path (m4a, ogg)
                for (const strategy of DOWNLOAD_STRATEGIES) {
                    const args = [
                        ...strategy.extraArgs,
                        ...sharedArgs(),
                        '-f', strategy.formatArg,
                        '--extract-audio',
                        '--audio-format', conversionFormat,
                        '--audio-quality', qualityArg,
                        '--newline',
                        '-o', outPattern,
                        cleanUrl,
                    ];
                    try { await spawnYtdlp(args, null); succeeded = true; break; } catch {}
                }
            }

            if (!succeeded) {
                logger.warn(`Batch track ${i+1} failed: ${cleanUrl}`);
                failCount++;
            }
            doneCount++;
        }

        // ── Zip using ffmpeg's concat or native zip if available, else Node fs ──
        updateDownloadStatus(downloadId, { status: 'Creating zip...', progress: 93, done: doneCount, total });

        // Collect all audio files in the batch dir
        const audioFiles = fs.readdirSync(batchDir)
            .filter(f => /\.(mp3|m4a|ogg|wav|opus)$/i.test(f))
            .sort();

        if (audioFiles.length === 0) throw new Error('No tracks were downloaded successfully');

        // Use archiver-style zip via Node's built-in zlib + streams (no external zip needed)
        await new Promise((resolve, reject) => {
            const output = fs.createWriteStream(zipPath);
            output.on('error', reject);

            // Write a valid ZIP file manually using Node's built-in modules
            // This avoids depending on the 'zip' CLI being installed
            const { createDeflateRaw } = require('zlib');
            const entries = [];
            let offset = 0;
            const buffers = [];

            function uint16LE(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
            function uint32LE(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }

            function crc32(buf) {
                let crc = 0xFFFFFFFF;
                for (const byte of buf) {
                    crc ^= byte;
                    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
                }
                return (crc ^ 0xFFFFFFFF) >>> 0;
            }

            (async () => {
                try {
                    for (const fname of audioFiles) {
                        const fpath    = path.join(batchDir, fname);
                        const fileData = await fs.promises.readFile(fpath);
                        const crc      = crc32(fileData);
                        const nameBytes = Buffer.from(fname, 'utf8');
                        const dosDate  = 0x5821; // 2024-01-01
                        const dosTime  = 0x0000;

                        // Local file header
                        const localHeader = Buffer.concat([
                            Buffer.from([0x50,0x4B,0x03,0x04]), // sig
                            uint16LE(20),           // version needed
                            uint16LE(0),            // flags
                            uint16LE(0),            // compression: stored (0 = no compression, fast)
                            uint16LE(dosTime),
                            uint16LE(dosDate),
                            uint32LE(crc),
                            uint32LE(fileData.length),
                            uint32LE(fileData.length),
                            uint16LE(nameBytes.length),
                            uint16LE(0),            // extra field length
                            nameBytes,
                        ]);

                        entries.push({ nameBytes, crc, size: fileData.length, offset, dosDate, dosTime });
                        offset += localHeader.length + fileData.length;
                        buffers.push(localHeader, fileData);
                    }

                    // Central directory
                    const cdStart = offset;
                    for (const e of entries) {
                        const cd = Buffer.concat([
                            Buffer.from([0x50,0x4B,0x01,0x02]),
                            uint16LE(20), uint16LE(20),
                            uint16LE(0),  uint16LE(0),
                            uint16LE(e.dosTime), uint16LE(e.dosDate),
                            uint32LE(e.crc),
                            uint32LE(e.size), uint32LE(e.size),
                            uint16LE(e.nameBytes.length),
                            uint16LE(0), uint16LE(0), uint16LE(0), uint16LE(0),
                            uint32LE(0),
                            uint32LE(e.offset),
                            e.nameBytes,
                        ]);
                        buffers.push(cd);
                        offset += cd.length;
                    }

                    // End of central directory
                    const cdSize = offset - cdStart;
                    const eocd = Buffer.concat([
                        Buffer.from([0x50,0x4B,0x05,0x06]),
                        uint16LE(0), uint16LE(0),
                        uint16LE(entries.length), uint16LE(entries.length),
                        uint32LE(cdSize),
                        uint32LE(cdStart),
                        uint16LE(0),
                    ]);
                    buffers.push(eocd);

                    output.end(Buffer.concat(buffers), resolve);
                } catch(e) { reject(e); }
            })();
        });

        // Clean up temp audio files but keep the zip
        try { fs.rmSync(batchDir, { recursive: true, force: true }); } catch {}

        const stat = fs.statSync(zipPath);
        if (stat.size === 0) throw new Error('Zip file is empty');

        // Register with persistent registry so it survives restarts
        registerFile(zipPath);
        logger.success(`Batch zip ready: ${zipName} (${(stat.size/1048576).toFixed(2)} MB) — ${doneCount - failCount}/${total} tracks`);

        updateDownloadStatus(downloadId, {
            status:      `Batch ready! (${doneCount - failCount}/${total} tracks)`,
            progress:    100,
            complete:    true,
            downloadUrl: `${BASE_PATH}/downloads/${encodeURIComponent(zipName)}`,
            filename:    zipName,
            expiresAt:   Date.now() + FILE_TTL_MS,
            isBatch:     true,
            done:        doneCount - failCount,
            total,
        });

    } catch (err) {
        logger.error(`Batch zip failed [${downloadId}]: ${err.message}`);
        updateDownloadStatus(downloadId, { error: true, status: `Failed: ${err.message}`, complete: true });
        try { fs.rmSync(batchDir, { recursive: true, force: true }); } catch {}
        if (fs.existsSync(zipPath)) try { fs.unlinkSync(zipPath); } catch {}
    }
}

fastify.get('/api/health', async (req, reply) => {
    const files = await fs.promises.readdir(MP3_STORAGE_PATH).catch(() => []);
    return reply.send({
        status:      'OK',
        files:       files.filter(f => !f.startsWith('temp_') && !f.startsWith('playlist_')).length,
        queue:       { waiting: queue.length, active: activeJobs, concurrency: QUEUE_CONCURRENCY },
        ytdlp:       YT_DLP,
        strategies:  DOWNLOAD_STRATEGIES.map(s => s.name),
    });
});

// ─── Startup ──────────────────────────────────────────────────────────────────

async function start() {
    loadOrCreateApiKey();
    loadRegistry();
    await checkDependencies();
    startCleanupSweep();
    startYtDlpAutoUpdate();

    try {
        await fastify.listen({ port: PORT, host: '0.0.0.0' });
        logger.divider();
        logger.success(`Server running:  http://localhost:${PORT}`);
        logger.info(`Storage:         ${MP3_STORAGE_PATH}`);
        logger.info(`API key:         ${API_KEY_FILE}  (${API_KEY.substring(0, 8)}...)`);
        logger.info(`Queue:           max ${QUEUE_CONCURRENCY} parallel jobs`);
        logger.info(`File TTL:        ${FILE_TTL_MS / 60000} minutes`);
        logger.divider();
    } catch (err) {
        logger.error('STARTUP ERROR:', err);
        process.exit(1);
    }
}

start();

// ─── Shutdown ─────────────────────────────────────────────────────────────────

async function shutdown(signal) {
    logger.divider('SHUTTING DOWN');
    logger.warn(`Signal: ${signal}`);
    try { await fastify.close(); logger.success('Done.'); process.exit(0); }
    catch (e) { logger.error(e); process.exit(1); }
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on('line', (l) => { if (l.trim().toLowerCase() === 'stop') shutdown('ADMIN'); });
