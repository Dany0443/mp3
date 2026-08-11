const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const {
    WEB_ROOT,
    MP3_STORAGE_PATH,
    CACHE_DIR,
    FILE_TTL_MS,
    MAX_REQUESTS,
    TIME_WINDOW,
    MAX_DOWNLOADS_PER_IP,
    BASE_PATH,
    getApiKey
} = require('./config');
const logger = require('./logger');
const {
    sanitizeFilename,
    cleanYoutubeUrl,
    isValidYouTubeUrl,
    extractVideoId,
    isPlaylistUrl,
    getMimeType,
    stripEmojis
} = require('./utils');
const { YT_DLP, DOWNLOAD_STRATEGIES } = require('./execEnv');
const { registerFile, fileRegistry } = require('./fileRegistry');
const {
    queue,
    getActiveJobs,
    activeDownloads,
    inFlightRequests,
    progressEmitter,
    trackIPDownload,
    untrackIPDownload,
    getActiveIPCount,
    updateDownloadStatus,
    enqueue
} = require('./queue');
const {
    durationCache,
    fetchVideoInfo,
    fetchPlaylistInfo,
    processYoutubeDownload,
    processPlaylistDownload,
    processBatchZip
} = require('./downloadService');

function requireAuth(request, reply) {
    const key = request.headers['x-api-key'] || request.query._k;
    if (!key || key !== getApiKey()) {
        reply.status(401).send({ error: 'Unauthorized' });
        return false;
    }
    return true;
}

const rateLimitCache = new Map();

function registerRoutes(fastify) {
    // Security headers and rate limiting
    fastify.addHook('onSend', async (request, reply) => {
        reply.header('X-Content-Type-Options', 'nosniff');
        reply.header('X-Frame-Options', 'SAMEORIGIN');
        reply.header('X-XSS-Protection', '1; mode=block');
        reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    });

    fastify.addHook('onRequest', (request, reply, done) => {
        if (/\.(css|js|png|jpg|ico|svg|woff2|ttf)$/.test(request.url)) return done();

        const ip  = request.ip;
        const now = Date.now();

        if (rateLimitCache.size > 200) {
            for (const [k, v] of rateLimitCache) {
                if (now - v.timestamp > TIME_WINDOW) rateLimitCache.delete(k);
            }
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

    // Static routes
    const serveStaticFile = async (req, reply, filename, contentType) => {
        const filePath = path.resolve(WEB_ROOT, filename);
        if (!filePath.startsWith(path.resolve(WEB_ROOT))) {
            return reply.status(403).send('Forbidden');
        }
        try {
            const content = await fs.promises.readFile(filePath);
            return reply.type(contentType).send(content);
        } catch {
            return reply.status(404).send('Not Found');
        }
    };

    fastify.get('/', (req, reply) => serveStaticFile(req, reply, 'index.html', 'text/html'));
    fastify.get('/style.css', (req, reply) => serveStaticFile(req, reply, 'style.css', 'text/css'));
    fastify.get('/script.js', (req, reply) => serveStaticFile(req, reply, 'script.js', 'application/javascript'));
    fastify.get('/cloud.png', (req, reply) => serveStaticFile(req, reply, 'cloud.png', 'image/png'));
    fastify.get('/favicon.ico', (req, reply) => serveStaticFile(req, reply, 'favicon.ico', 'image/x-icon'));
    fastify.get('/favicon.svg', (req, reply) => serveStaticFile(req, reply, 'favicon.svg', 'image/svg+xml'));
    fastify.get('/favicon-192.png', (req, reply) => serveStaticFile(req, reply, 'favicon-192.png', 'image/png'));
    fastify.get('/favicon-512.png', (req, reply) => serveStaticFile(req, reply, 'favicon-512.png', 'image/png'));
    fastify.get('/manifest.json', (req, reply) => serveStaticFile(req, reply, 'manifest.json', 'application/manifest+json'));

    fastify.get('/vendor/fa/all.min.css', (req, reply) => serveStaticFile(req, reply, 'vendor/fa/all.min.css', 'text/css'));
    fastify.get('/vendor/fa/webfonts/:file', async (req, reply) => {
        const safeFile = path.basename(req.params.file);
        return serveStaticFile(req, reply, path.join('vendor/fa/webfonts', safeFile), 'font/woff2');
    });
    fastify.get('/vendor/fonts/fonts.css', (req, reply) => serveStaticFile(req, reply, 'vendor/fonts/fonts.css', 'text/css'));
    fastify.get('/vendor/fonts/:file', async (req, reply) => {
        const safeFile = path.basename(req.params.file);
        return serveStaticFile(req, reply, path.join('vendor/fonts', safeFile), 'font/woff2');
    });

    // API routes
    fastify.get('/api/client-key', async (req, reply) => {
        return reply.send({ key: getApiKey() });
    });

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
                    entries: entries.map(e => ({
                        id: e.id,
                        title: stripEmojis(e.title || ''),
                        url: e.url || e.webpage_url || `https://www.youtube.com/watch?v=${e.id}`,
                        duration: e.duration,
                        uploader: stripEmojis(e.uploader || e.channel || ''),
                        thumbnailUrl: e.thumbnails?.slice(-1)[0]?.url || '',
                    }))
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

        const clientIP = req.ip;
        const ipActive = getActiveIPCount(clientIP);
        if (!isPlaylistUrl(url) && ipActive >= MAX_DOWNLOADS_PER_IP) {
            return reply.status(429).send({ error: `Too many active downloads (max ${MAX_DOWNLOADS_PER_IP} per IP). Please wait for one to finish.` });
        }

        if (!isValidYouTubeUrl(url)) {
            logger.warn(`Rejected invalid URL: ${url}`);
            return reply.status(400).send({ error: 'Invalid YouTube URL' });
        }

        const cleanUrl = cleanYoutubeUrl(url);
        if (!cleanUrl) return reply.status(400).send({ error: 'Invalid YouTube URL' });

        const id = uuidv4();
        const isPlaylist = isPlaylistUrl(cleanUrl);

        let fileHash = null;
        if (!isPlaylist) {
            fileHash = crypto.createHash('md5').update(`${cleanUrl}-${format}-${quality}`).digest('hex');
            const cachedFilePath = path.join(CACHE_DIR, `${fileHash}.${format}`);

            if (fs.existsSync(cachedFilePath)) {
                logger.success(`Cache hit: ${fileHash}`);

                const displayTitle = customFilename || `Download_${id.substring(0,6)}`;
                const finalFilename = sanitizeFilename(displayTitle) + `.${format}`;
                const finalPath = path.join(MP3_STORAGE_PATH, finalFilename);

                await fs.promises.copyFile(cachedFilePath, finalPath);
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
        const doEmbedThumb = (embedThumb === '1' || embedThumbnail === '1');

        const dedupKey = !isPlaylist && !isPreview ? `${cleanUrl}-${format}-${quality}` : null;
        if (dedupKey && inFlightRequests.has(dedupKey)) {
            logger.info(`Reusing in-flight job for ${dedupKey.substring(0, 60)}`);
            const existingId = await inFlightRequests.get(dedupKey);
            return reply.send({ id: existingId, isPlaylist: false, deduped: true });
        }

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
            const tagSummary = [metaTags.title, metaTags.artist].filter(Boolean).join(' ') || '(custom tags)';
            logger.info(`[${id}] Meta: ${tagSummary}`);
        }

        activeDownloads.set(id, { status: 'Queued', progress: 0, isPlaylist });
        if (dedupKey) inFlightRequests.set(dedupKey, Promise.resolve(id));

        if (isPlaylist) {
            enqueue(() => processPlaylistDownload(cleanUrl, id, format || 'mp3', parseInt(quality, 10) || 192, doEmbedThumb, metaTags), id)
                .catch(err => logger.error('Unhandled playlist error:', err));
        } else {
            trackIPDownload(clientIP);
            enqueue(() => processYoutubeDownload(cleanUrl, id, format || 'mp3', parseInt(quality, 10) || 192, customFilename, isPreview, doEmbedThumb, metaTags), id)
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
                .catch(err => logger.error('Unhandled download error:', err))
                .finally(() => {
                    untrackIPDownload(clientIP);
                    if (dedupKey) inFlightRequests.delete(dedupKey);
                });
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
                progressEmitter.removeListener(`progress-${id}`, listener);
                try { reply.raw.end(); } catch {}
            }
        };

        progressEmitter.on(`progress-${id}`, listener);
        req.raw.on('close', () => progressEmitter.removeListener(`progress-${id}`, listener));
    });

    // File download route
    fastify.get('/downloads/:filename', async (req, reply) => {
        if (!requireAuth(req, reply)) return;

        const rawFilename = decodeURIComponent(req.params.filename);
        const safeName    = path.basename(rawFilename);
        const filePath    = path.resolve(MP3_STORAGE_PATH, safeName);

        if (!filePath.startsWith(path.resolve(MP3_STORAGE_PATH))) {
            return reply.status(403).send('Forbidden: Invalid file path');
        }

        logger.info(`Serve: ${safeName}`);

        try {
            await fs.promises.access(filePath, fs.constants.R_OK);
            const stat = await fs.promises.stat(filePath);
            if (stat.size === 0) return reply.status(500).send('File conversion failed (empty).');

            const ext      = path.extname(safeName).replace('.', '').toLowerCase();
            const mimeType = getMimeType(ext);

            const expiresAt = fileRegistry.get(safeName);
            const remaining = expiresAt ? Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)) : null;

            reply.header('Content-Length', stat.size);
            reply.header('Content-Type', mimeType);
            reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(safeName)}"`);
            reply.header('Accept-Ranges', 'bytes');
            if (remaining !== null) reply.header('X-Expires-In', `${remaining}s`);

            const stream = fs.createReadStream(filePath);
            stream.on('error', (e) => { logger.error(`Stream error: ${e.message}`); try { reply.raw.end(); } catch {} });
            return reply.send(stream);

        } catch (err) {
            logger.error(`File not found: ${safeName}: ${err.message}`);
            return reply.status(404).send('File not found or has expired. Please try again.');
        }
    });

    fastify.post('/api/batch-zip', async (req, reply) => {
        if (!requireAuth(req, reply)) return;

        const { urls, format, quality } = req.body || {};
        if (!Array.isArray(urls) || urls.length === 0)
            return reply.status(400).send({ error: 'No URLs provided' });

        const id = uuidv4();
        activeDownloads.set(id, { status: 'Queued', progress: 0, isBatch: true, total: urls.length, done: 0 });
        reply.send({ id });

        processBatchZip(urls, id, format || 'mp3', parseInt(quality, 10) || 192)
            .catch(err => logger.error('Unhandled batch-zip error:', err));
    });

    fastify.post('/api/check-files', async (req, reply) => {
        if (!requireAuth(req, reply)) return;
        const { items } = req.body || {};
        if (!Array.isArray(items)) return reply.status(400).send({ error: 'items must be array' });

        const results = {};
        for (const { filename, sourceUrl, format, quality } of items) {
            if (!filename || typeof filename !== 'string') continue;
            const safe = path.basename(filename);
            const targetPath = path.resolve(MP3_STORAGE_PATH, safe);
            if (!targetPath.startsWith(path.resolve(MP3_STORAGE_PATH))) continue;

            const inStorage = fs.existsSync(targetPath);
            let inCache = false;
            if (!inStorage && sourceUrl && format && quality) {
                try {
                    const cleanUrl  = cleanYoutubeUrl(sourceUrl);
                    if (cleanUrl) {
                        const hash      = crypto.createHash('md5').update(`${cleanUrl}-${format}-${quality}`).digest('hex');
                        const cachePath = path.join(CACHE_DIR, `${hash}.${format}`);
                        inCache = fs.existsSync(cachePath);
                    }
                } catch {}
            }

            results[safe] = { available: inStorage, cached: inCache };
        }
        const available = Object.values(results).filter(r => r.available || r.cached).length;
        const total     = Object.keys(results).length;
        if (total > 0) {
            if (available > 0) {
                logger.info(`check-files: ${available}/${total} available in storage`);
            } else {
                logger.info(`check-files: checked ${total} file(s): none in storage`);
            }
        }
        return reply.send({ results });
    });

    fastify.get('/api/health', async (req, reply) => {
        const files = await fs.promises.readdir(MP3_STORAGE_PATH).catch(() => []);
        return reply.send({
            status:      'OK',
            files:       files.filter(f => !f.startsWith('temp_') && !f.startsWith('playlist_') && f !== '.cache' && f !== '.registry.json').length,
            queue:       { waiting: queue.length, active: getActiveJobs() },
            ytdlp:       YT_DLP,
            strategies:  DOWNLOAD_STRATEGIES.map(s => s.name),
        });
    });
}

module.exports = { registerRoutes };
