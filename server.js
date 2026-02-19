const path      = require('path');
const fs        = require('fs');
const crypto    = require('crypto');
const { v4: uuidv4 }  = require('uuid');
const { exec, spawn } = require('child_process');
const { promisify }   = require('util');
const execAsync       = promisify(exec);
const readline        = require('readline');

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT             = process.env.PORT || 3556;
const MP3_STORAGE_PATH = path.join(__dirname, 'temp', 'mp3');
const WEB_ROOT         = path.join(__dirname, 'web');
const MAX_REQUESTS     = parseInt(process.env.MAX_REQUESTS) || 100;
const TIME_WINDOW      = parseInt(process.env.TIME_WINDOW)  || 60000;
const FILE_TTL_MS      = 60 * 60 * 1000; // 1 hour
const QUEUE_CONCURRENCY = 3; // max parallel yt-dlp jobs

// API key auth — set via env or auto-generate on first run.
// The key is saved to .apikey file so it survives restarts.
// Clients must send header:  X-API-Key: <key>
// The web UI reads its key from /api/client-key (served only once per session).
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

// fileRegistry tracks every completed file so the cleanup sweep can delete
// them after FILE_TTL_MS even if the process restarts between sweeps.
// Structure: Map<filename, expiresAt (ms epoch)>
const fileRegistry = new Map();

function registerFile(filePath) {
    const name = path.basename(filePath);
    const expiresAt = Date.now() + FILE_TTL_MS;
    fileRegistry.set(name, expiresAt);
}

// Sweep runs every 5 minutes. Deletes any file whose TTL has passed.
function startCleanupSweep() {
    setInterval(() => {
        const now = Date.now();
        for (const [name, expiresAt] of fileRegistry) {
            if (now >= expiresAt) {
                const full = path.join(MP3_STORAGE_PATH, name);
                try { fs.unlinkSync(full); logger.info(`Swept: ${name}`); } catch {}
                fileRegistry.delete(name);
            }
        }
        // Also clean up any orphaned temp_ files older than 2 hours
        try {
            const files = fs.readdirSync(MP3_STORAGE_PATH);
            for (const f of files) {
                if (!f.startsWith('temp_')) continue;
                const full = path.join(MP3_STORAGE_PATH, f);
                try {
                    const age = now - fs.statSync(full).mtimeMs;
                    if (age > 2 * 60 * 60 * 1000) { fs.unlinkSync(full); }
                } catch {}
            }
        } catch {}
    }, 5 * 60 * 1000);
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

function buildEnv() {
    const extra = DENO_PATH ? path.dirname(DENO_PATH) : null;
    const base  = process.env.PATH || '/usr/bin:/bin:/usr/local/bin';
    return { ...process.env, PATH: extra ? `${extra}:${base}` : base };
}

// ─── Download strategies ───────────────────────────────────────────────────────
// Tried in order. android_sdkless bypasses YouTube SABR streaming (2025+)
// without needing po_token or cookies.

const DOWNLOAD_STRATEGIES = [
    {
        name: 'android_sdkless',
        extraArgs: ['--extractor-args', 'youtube:player_client=android_sdkless'],
        formatArg: 'bestaudio/best',
    },
    {
        name: 'ios',
        extraArgs: ['--extractor-args', 'youtube:player_client=ios,android_sdkless'],
        formatArg: 'bestaudio/best',
    },
    {
        name: 'default+hls',
        extraArgs: ['--extractor-args', 'youtube:player_client=default'],
        formatArg: 'bestaudio/b',
    },
];

function sharedArgs(isPlaylist = false) {
    return [
        '--no-check-certificate',
        isPlaylist ? '--yes-playlist' : '--no-playlist',
        '--no-warnings',
        '--socket-timeout', '30',
        '--retries', '5',
        '--fragment-retries', '5',
        '--retry-sleep', '3',
    ];
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
        logger.error(`yt-dlp not found. Install: sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && sudo chmod a+rx /usr/local/bin/yt-dlp`);
    }

    if (DENO_PATH) {
        try {
            const { stdout } = await execAsync(`"${DENO_PATH}" --version 2>&1`);
            logger.success(`deno: ${DENO_PATH}  (${stdout.split('\n')[0].trim()})`);
        } catch {
            logger.warn(`deno found at ${DENO_PATH} but failed to run`);
        }
    } else {
        logger.warn('deno not found — nsig solving will fail. Install: curl -fsSL https://deno.land/install.sh | sh');
    }

    try {
        const { stdout } = await execAsync('ffmpeg -version 2>&1');
        logger.success(`ffmpeg: ${stdout.split('\n')[0].trim().substring(0, 60)}`);
    } catch {
        logger.error('ffmpeg not found. Install: sudo apt install ffmpeg');
    }

    logger.info(`Auto-update cron (run once to set up): crontab -e`);
    logger.info(`  Add this line:  0 3 * * 1  ${YT_DLP} -U >> /var/log/ytdlp-update.log 2>&1`);
    logger.info(`  That updates yt-dlp every Monday at 3am automatically.`);

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
// Simple concurrency-limited FIFO queue. Each item is a { fn, resolve, reject }.

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

function updateDownloadStatus(id, updates) {
    const next = { ...(activeDownloads.get(id) || {}), ...updates };
    activeDownloads.set(id, next);
    process.emit(`progress-${id}`, next);
}

// ─── yt-dlp spawner ───────────────────────────────────────────────────────────

function spawnYtdlp(args, onProgress) {
    return new Promise((resolve, reject) => {
        const child = spawn(YT_DLP, args, { env: buildEnv() });
        let stderr = '';

        child.stdout.on('data', (data) => {
            if (!onProgress) return;
            const lines = data.toString().split('\n');
            for (const line of [...lines].reverse()) {
                const m = line.match(/\[download\]\s+(\d+\.?\d*)%/);
                if (m) { onProgress('download', parseFloat(m[1])); break; }
                if (line.includes('Destination') || line.includes('Extracting') || line.includes('Converting')) {
                    onProgress('convert'); break;
                }
            }
        });

        child.stderr.on('data', (d) => {
            const t = d.toString().trim();
            if (t && !t.includes('Does not start with RIFF')) {
                stderr += t + '\n';
                logger.warn(`[yt-dlp] ${t}`);
            }
        });

        child.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`yt-dlp exited ${code}: ${stderr.slice(-400)}`));
        });
    });
}

// ─── Video info ───────────────────────────────────────────────────────────────

async function fetchVideoInfo(url) {
    for (const strategy of DOWNLOAD_STRATEGIES) {
        try {
            const args = [...strategy.extraArgs, ...sharedArgs(), '--dump-json', url];
            const cmd  = `"${YT_DLP}" ${args.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`;
            const { stdout } = await execAsync(cmd, { maxBuffer: 10 * 1024 * 1024, timeout: 40000, env: buildEnv() });
            return JSON.parse(stdout);
        } catch (err) {
            logger.warn(`Info strategy "${strategy.name}" failed: ${err.message.slice(0, 150)}`);
        }
    }
    throw new Error('All strategies failed to fetch video info');
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

async function processYoutubeDownload(url, downloadId, audioFormat = 'mp3', quality = 192, outputFilename, isPreview = false) {
    let finalOutputPath = null;
    try {
        updateDownloadStatus(downloadId, { status: isPreview ? 'Generating preview...' : 'Initializing...', progress: 5 });

        const formatMap = { ogg: 'vorbis', m4a: 'aac' };
        const conversionFormat = formatMap[audioFormat] || audioFormat;

        let filename = sanitizeFilename(outputFilename || 'download');
        const extRe = new RegExp(`\\.${audioFormat}$`, 'i');
        if (!extRe.test(filename)) filename = filename.replace(/\.[^/.]+$/, '') + '.' + audioFormat;

        finalOutputPath = path.join(MP3_STORAGE_PATH, filename);
        const tempPattern = path.join(MP3_STORAGE_PATH, `temp_${downloadId}.%(ext)s`);

        const qualityArg = (audioFormat === 'm4a' || audioFormat === 'wav')
            ? `${quality}K`
            : `${Math.floor((320 - quality) / 320 * 9)}`;

        let lastProgress = 0;
        const onProgress = (type, pct) => {
            if (type === 'download' && pct !== undefined) {
                const calc = 10 + Math.floor(pct * 0.85);
                if (calc > lastProgress) {
                    lastProgress = calc;
                    updateDownloadStatus(downloadId, { status: `Downloading: ${Math.floor(pct)}%`, progress: lastProgress });
                }
            } else if (type === 'convert' && lastProgress < 95) {
                lastProgress = 95;
                updateDownloadStatus(downloadId, { status: 'Finalizing audio...', progress: 95 });
            }
        };

        let succeeded = false;
        let lastError  = null;

        for (const strategy of DOWNLOAD_STRATEGIES) {
            logger.info(`[${downloadId}] trying: ${strategy.name}`);
            try {
                const stale = fs.readdirSync(MP3_STORAGE_PATH).filter(f => f.startsWith(`temp_${downloadId}`));
                for (const f of stale) fs.unlinkSync(path.join(MP3_STORAGE_PATH, f));
            } catch {}

            const args = [
                ...strategy.extraArgs,
                ...sharedArgs(),
                '-f', strategy.formatArg,
                '--extract-audio',
                '--audio-format', conversionFormat,
                '--audio-quality', qualityArg,
                '--newline',
                ...(isPreview ? ['--download-sections', '*0-30', '--force-keyframes-at-cuts'] : []),
                '-o', tempPattern,
                url,
            ];

            try {
                await spawnYtdlp(args, onProgress);
                succeeded = true;
                logger.success(`[${downloadId}] strategy "${strategy.name}" succeeded`);
                break;
            } catch (err) {
                lastError = err;
                logger.warn(`[${downloadId}] strategy "${strategy.name}" failed: ${err.message.slice(0, 200)}`);
            }
        }

        if (!succeeded) throw lastError || new Error('All download strategies failed');

        const tmpFile = fs.readdirSync(MP3_STORAGE_PATH).find(f => f.startsWith(`temp_${downloadId}`));
        if (!tmpFile) throw new Error('Output file not generated by yt-dlp.');

        const tmpPath = path.join(MP3_STORAGE_PATH, tmpFile);
        if (fs.existsSync(finalOutputPath)) fs.unlinkSync(finalOutputPath);
        fs.renameSync(tmpPath, finalOutputPath);

        const stat = fs.statSync(finalOutputPath);
        if (stat.size === 0) throw new Error('Converted file is empty.');

        registerFile(finalOutputPath);
        logger.success(`Ready: ${filename} (${(stat.size / 1048576).toFixed(2)} MB) — expires in 1h`);

        updateDownloadStatus(downloadId, {
            status: 'Done!',
            progress: 100,
            complete: true,
            downloadUrl: `/downloads/${encodeURIComponent(filename)}`,
            filename,
            expiresAt: Date.now() + FILE_TTL_MS,
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

async function processPlaylistDownload(url, downloadId, audioFormat = 'mp3', quality = 192) {
    const formatMap = { ogg: 'vorbis', m4a: 'aac' };
    const conversionFormat = formatMap[audioFormat] || audioFormat;
    const qualityArg = (audioFormat === 'm4a' || audioFormat === 'wav')
        ? `${quality}K`
        : `${Math.floor((320 - quality) / 320 * 9)}`;

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

        // Zip the folder using the system zip command (no extra npm dep)
        const zipName = `${playlistTitle}.zip`;
        zipPath = path.join(MP3_STORAGE_PATH, zipName);
        await execAsync(`cd "${tempDir}" && zip -r "${zipPath}" .`, { timeout: 120000 });

        // Remove temp track folder
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}

        const stat = fs.statSync(zipPath);
        if (stat.size === 0) throw new Error('Zip file is empty.');

        registerFile(zipPath);
        logger.success(`Playlist ready: ${zipName} (${(stat.size / 1048576).toFixed(2)} MB) — expires in 1h`);

        updateDownloadStatus(downloadId, {
            status: 'Playlist ready!',
            progress: 100,
            complete: true,
            downloadUrl: `/downloads/${encodeURIComponent(zipName)}`,
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
    logger: false,
    bodyLimit: 10485760,
    requestTimeout: 300000,
    keepAliveTimeout: 600000,
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

    if (rateLimitCache.size > 10000) {
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
// All /api/* routes require X-API-Key header matching API_KEY.
// Static files and the root HTML are public so the page loads for anyone.
// /api/client-key is the one endpoint that returns the key to the browser
// — it's how the web UI bootstraps itself. It's still rate-limited above.

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

fastify.get('/manifest.json', async (req, reply) => {
    try { return reply.type('application/manifest+json').send(await fs.promises.readFile(path.join(WEB_ROOT, 'manifest.json'))); }
    catch { return reply.status(404).send(''); }
});

fastify.get('/script.js', async (req, reply) => {
    try { return reply.type('application/javascript').send(await fs.promises.readFile(path.join(WEB_ROOT, 'script.js'))); }
    catch { return reply.status(404).send(''); }
});

// The browser calls this once on load to get its session key.
// This is what keeps it "free for all" on the client — the page just works
// when you open it, but all API calls are still authenticated.
fastify.get('/api/client-key', async (req, reply) => {
    return reply.send({ key: API_KEY });
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
                isPlaylist: true,
                title: entries[0]?.playlist_title || entries[0]?.playlist || 'Playlist',
                count: entries.length,
                thumbnailUrl: entries[0]?.thumbnails?.slice(-1)[0]?.url || '',
            });
        }

        const info = await fetchVideoInfo(cleanUrl);
        return reply.send({
            isPlaylist:    false,
            title:         stripEmojis(info.title    || 'Unknown Title'),
            author:        stripEmojis(info.uploader || info.channel || 'Unknown'),
            lengthSeconds: parseInt(info.duration   || '0'),
            thumbnailUrl:  info.thumbnail || '',
        });
    } catch (err) {
        logger.error('video-info failed:', err.message);
        return reply.status(500).send({ error: 'Failed to fetch info', message: err.message });
    }
});

fastify.get('/api/download', async (req, reply) => {
    if (!requireAuth(req, reply)) return;

    const { url, format, quality, filename, preview } = req.query;
    const cleanUrl = cleanYoutubeUrl(url);
    if (!cleanUrl) return reply.status(400).send({ error: 'Invalid YouTube URL' });

    const id = uuidv4();
    const isPlaylist = isPlaylistUrl(cleanUrl);
    const isPreview  = preview === '1';

    activeDownloads.set(id, { status: 'Queued', progress: 0, isPlaylist });

    if (isPlaylist) {
        enqueue(() => processPlaylistDownload(cleanUrl, id, format || 'mp3', parseInt(quality) || 192))
            .catch(err => logger.error('Unhandled playlist error:', err));
    } else {
        enqueue(() => processYoutubeDownload(cleanUrl, id, format || 'mp3', parseInt(quality) || 192, filename, isPreview))
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
    await checkDependencies();
    startCleanupSweep();

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