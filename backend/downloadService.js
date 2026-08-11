const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const archiver = require('archiver');
const { MP3_STORAGE_PATH, CACHE_DIR, FILE_TTL_MS, COOKIES_FILE, BASE_PATH } = require('./config');
const logger = require('./logger');
const { stripEmojis, sanitizeFilename, extractVideoId, httpGet, httpGetText } = require('./utils');
const { YT_DLP, CHILD_ENV, safeExecFile } = require('./execEnv');
const { registerFile } = require('./fileRegistry');
const { updateDownloadStatus } = require('./queue');

const DOWNLOAD_STRATEGIES = [
    { name: 'default', extraArgs: ['--extractor-args', 'youtube:player_client=default,-android_sdkless', '--remote-components', 'ejs:github'], formatArg: 'ba' },
    { name: 'mweb',    extraArgs: ['--extractor-args', 'youtube:player_client=mweb', '--remote-components', 'ejs:github'],                     formatArg: 'ba' },
    { name: 'ios',     extraArgs: ['--extractor-args', 'youtube:player_client=ios', '--remote-components', 'ejs:github'],                      formatArg: 'ba' },
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

function buildQualityArg(audioFormat, quality) {
    switch (audioFormat) {
        case 'wav':
        case 'm4a':
            return `${quality}K`;
        case 'ogg': {
            const v = Math.round((quality - 128) / 48 * 2 + 3);
            return String(Math.min(10, Math.max(0, v)));
        }
        case 'mp3':
        default:
            return `${quality}K`;
    }
}

function buildTagPostprocessorArgs(metaTags) {
    if (!metaTags) return [];
    return [];
}

async function downloadAndEncodePiped(url, strategy, outputPath, ffmpegAudioArgs, isPreview, onProgress) {
    return new Promise((resolve, reject) => {
        const ytArgs = [
            ...strategy.extraArgs,
            '--no-check-certificate', '--no-playlist', '--no-warnings',
            '--socket-timeout', '15', '--retries', '3',
            '--concurrent-fragments', '4', '--buffer-size', '16K',
            ...(COOKIES_FILE ? ['--cookies', COOKIES_FILE] : []),
            '-f', strategy.formatArg,
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

        ytdlp.stdout.on('error', () => {});
        ffmpeg.stdin.on('error', () => {});

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

function spawnYtdlp(args, onProgress) {
    return new Promise((resolve, reject) => {
        const child = spawn(YT_DLP, args, { env: CHILD_ENV });
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
            stderr += d.toString().trim() + '\n';
        });

        child.on('close', (code) => {
            if (code === 0) resolve();
            else {
                const lastLine = stderr.trim().split('\n').pop() || `exit ${code}`;
                logger.error(`yt-dlp failed (${code}): ${lastLine}`);
                reject(new Error(`yt-dlp exited ${code}`));
            }
        });
    });
}

const oembedCache = new Map();
const OEMBED_TTL = 30 * 60 * 1000;

async function fetchVideoInfoFast(url) {
    const vidId  = extractVideoId(url);
    const cached = vidId && oembedCache.get(vidId);
    if (cached && cached.expiresAt > Date.now()) return cached.data;

    const encoded = encodeURIComponent(url);
    const data    = await httpGet(
        `https://www.youtube.com/oembed?url=${encoded}&format=json`,
        2500
    );

    if (!data.title) throw new Error('oEmbed returned no title');

    const thumb = vidId
        ? `https://i.ytimg.com/vi/${vidId}/hqdefault.jpg`
        : (data.thumbnail_url || '');

    const result = {
        title:         stripEmojis(data.title),
        author:        stripEmojis(data.author_name || 'Unknown'),
        lengthSeconds: 0,
        thumbnailUrl:  thumb,
        fromOembed:    true,
    };

    if (vidId) {
        if (oembedCache.size >= 200) oembedCache.delete(oembedCache.keys().next().value);
        oembedCache.set(vidId, { data: result, expiresAt: Date.now() + OEMBED_TTL });
    }
    return result;
}

const durationCache = new Map();
const DURATION_CACHE_MAX = 500;

async function enrichDurationAsync(url, videoId) {
    if (!videoId) return;
    if (durationCache.has(videoId)) return;
    try {
        const html  = await httpGetText(`https://www.youtube.com/watch?v=${videoId}`, 6000);
        const match = html.match(/"lengthSeconds":"(\d+)"/);
        if (!match) throw new Error('lengthSeconds not found in page');
        const secs  = parseInt(match[1], 10);
        if (isNaN(secs) || secs <= 0) throw new Error('invalid duration');
        if (durationCache.size >= DURATION_CACHE_MAX) durationCache.delete(durationCache.keys().next().value);
        durationCache.set(videoId, secs);
        logger.info(`Duration cached: ${videoId} = ${secs}s`);
    } catch (pageErr) {
        try {
            const args = ['--no-playlist', '--no-warnings', '--retries', '1', '--socket-timeout', '8', '--extractor-args', 'youtube:player_client=tv_embedded', '--print', 'duration', url];
            const { stdout } = await safeExecFile(YT_DLP, args, { timeout: 12000 });
            const secs = parseInt(stdout.trim(), 10);
            if (!isNaN(secs) && secs > 0) {
                if (durationCache.size >= DURATION_CACHE_MAX) durationCache.delete(durationCache.keys().next().value);
                durationCache.set(videoId, secs);
                logger.info(`Duration cached (yt-dlp fallback): ${videoId} = ${secs}s`);
            }
        } catch {}
    }
}

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
            const { stdout } = await safeExecFile(YT_DLP, args, { maxBuffer: 10 * 1024 * 1024, timeout: 40000 });
            const info = JSON.parse(stdout);
            logger.info(`yt-dlp info took ${Date.now() - t1}ms via ${strategy.name}`);
            return {
                title:         stripEmojis(info.title    || 'Unknown Title'),
                author:        stripEmojis(info.uploader || info.channel || 'Unknown'),
                lengthSeconds: parseInt(info.duration    || '0', 10),
                thumbnailUrl:  info.thumbnail || '',
                fromOembed:    false,
            };
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
            const { stdout } = await safeExecFile(YT_DLP, args, { maxBuffer: 20 * 1024 * 1024, timeout: 60000 });
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

        const usePipe = (audioFormat === 'mp3' || audioFormat === 'wav') && !embedThumbnail;

        if (usePipe) {
            const metaParts = [];
            const finalTitle  = (metaTags && !isPreview) ? (metaTags.title  || '') : '';
            const finalArtist = (metaTags && !isPreview) ? (metaTags.artist || '') : '';

            if (finalTitle)  metaParts.push('-metadata', `title=${finalTitle}`);
            if (finalArtist) metaParts.push('-metadata', `artist=${finalArtist}`);

            if (metaTags && !isPreview) {
                if (metaTags.album)  metaParts.push('-metadata', `album=${metaTags.album}`);
                if (metaTags.year)   metaParts.push('-metadata', `date=${metaTags.year}`);
                if (metaTags.genre)  metaParts.push('-metadata', `genre=${metaTags.genre}`);
                if (metaTags.track)  metaParts.push('-metadata', `track=${metaTags.track}`);
            }
            const ffmpegAudioArgs = audioFormat === 'mp3'
                ? ['-map_metadata', '-1', '-id3v2_version', '3', '-c:a', 'libmp3lame', '-b:a', `${quality}k`, ...metaParts]
                : ['-map_metadata', '-1', '-id3v2_version', '3', '-c:a', 'libvorbis', '-q:a', '5', ...metaParts];
            
            let succeeded = false, lastError = null;
            for (const strategy of DOWNLOAD_STRATEGIES) {
                try {
                    if (fs.existsSync(finalOutputPath)) fs.unlinkSync(finalOutputPath);
                    await downloadAndEncodePiped(url, strategy, finalOutputPath, ffmpegAudioArgs, isPreview, onProgress);
                    succeeded = true;
                    logger.success(`[${downloadId}] Done via pipe/${audioFormat} (${strategy.name})`);
                    break;
                } catch (err) {
                    lastError = err;
                    logger.warn(`[${downloadId}] pipe/${audioFormat} "${strategy.name}" failed: ${err.message.slice(0,200)}`);
                    if (fs.existsSync(finalOutputPath)) try { fs.unlinkSync(finalOutputPath); } catch {}
                }
            }
            if (!succeeded) throw lastError || new Error('All pipe strategies failed');

        } else {
            const tempPattern = path.join(MP3_STORAGE_PATH, `temp_${downloadId}.%(ext)s`);
            const tagArgs = (metaTags && !isPreview) ? buildTagPostprocessorArgs(metaTags) : [];

            let succeeded = false, lastError = null;
            for (const strategy of DOWNLOAD_STRATEGIES) {
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
                    logger.success(`[${downloadId}] Done via ${strategy.name}`);
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

        // Register file for cleanup
        registerFile(finalOutputPath);

        updateDownloadStatus(downloadId, {
            status:       'Done!',
            progress:     100,
            complete:     true,
            downloadUrl:  `${BASE_PATH}/downloads/${encodeURIComponent(filename)}`,
            filename,
            expiresAt:    Date.now() + FILE_TTL_MS,
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

async function processPlaylistDownload(url, downloadId, audioFormat = 'mp3', quality = 192, embedThumbnail = false, metaTags = null) {
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

        const trackStatuses = entries.map((e, i) => ({
            index: i,
            id: e.id,
            title: stripEmojis(e.title || `Track ${i+1}`),
            status: 'pending'
        }));

        updateDownloadStatus(downloadId, {
            status: `Downloading playlist: ${total} tracks`,
            progress: 5,
            total,
            done: 0,
            trackStatuses
        });

        let doneCount = 0;
        let failedCount = 0;

        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            const videoUrl = entry.url || entry.webpage_url || `https://www.youtube.com/watch?v=${entry.id}`;
            const trackName = sanitizeFilename(entry.title || `track_${i + 1}`);
            const outPattern = path.join(tempDir, `${String(i + 1).padStart(3, '0')}_${trackName}.%(ext)s`);

            trackStatuses[i].status = 'downloading';
            updateDownloadStatus(downloadId, {
                status: `[${i+1}/${total}] ${trackName}`,
                progress: 5 + Math.floor((i / total) * 88),
                done: doneCount,
                total,
                failed: failedCount,
                trackStatuses
            });

            const artistName = stripEmojis(entry.uploader || entry.channel || playlistTitle);
            const trackTags = {
                title:  metaTags?.title ?? trackName,
                artist: metaTags?.artist ?? artistName,
                album:  metaTags?.album ?? playlistTitle,
                track:  metaTags?.track ?? `${i + 1}/${total}`,
                year:   metaTags?.year ?? null,
                genre:  metaTags?.genre ?? null,
            };
            const trackTagArgs = buildTagPostprocessorArgs(trackTags);

            let trackSucceeded = false;
            for (const strategy of DOWNLOAD_STRATEGIES) {
                const args = [
                    ...strategy.extraArgs,
                    ...sharedArgs(),
                    '-f', 'bestaudio/best',
                    '--extract-audio',
                    '--audio-format', conversionFormat,
                    '--audio-quality', qualityArg,
                    '--newline',
                    ...(embedThumbnail ? ['--embed-thumbnail', '--convert-thumbnails', 'jpg'] : []),
                    ...trackTagArgs,
                    '-o', outPattern,
                    videoUrl,
                ];
                try {
                    logger.info(`[${downloadId}] Track ${i+1}: trying ${strategy.name}`);
                    await spawnYtdlp(args, null);
                    trackSucceeded = true;
                    break;
                } catch (err) {
                    logger.warn(`[${downloadId}] Track ${i+1} strategy ${strategy.name} failed: ${err.message}`);
                }
            }

            if (trackSucceeded) {
                trackStatuses[i].status = 'success';
                doneCount++;
                logger.success(`[${downloadId}] Track ${i+1} succeeded: ${trackName}`);
            } else {
                trackStatuses[i].status = 'failed';
                failedCount++;
                logger.warn(`[${downloadId}] Playlist track ${i+1} failed, skipping: ${videoUrl}`);
            }
        }

        updateDownloadStatus(downloadId, { status: 'Creating zip...', progress: 95, trackStatuses, done: doneCount, failed: failedCount });

        const zipName = `${playlistTitle}.zip`;
        zipPath = path.join(MP3_STORAGE_PATH, zipName);

        const audioFiles = fs.readdirSync(tempDir)
            .filter(f => /\.(mp3|m4a|ogg|wav|opus)$/i.test(f))
            .sort();
        if (audioFiles.length === 0) throw new Error('No tracks were downloaded successfully');

        await new Promise((resolve, reject) => {
            const output  = fs.createWriteStream(zipPath);
            const archive = archiver('zip', { zlib: { level: 0 } });
            output.on('close', resolve);
            archive.on('error', reject);
            archive.pipe(output);
            for (const fname of audioFiles) {
                archive.file(path.join(tempDir, fname), { name: fname });
            }
            archive.finalize();
        });

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
            failed: failedCount,
            total,
            trackStatuses
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

async function processBatchZip(urls, downloadId, audioFormat, quality) {
    const formatMap        = { ogg: 'vorbis', m4a: 'aac' };
    const conversionFormat = formatMap[audioFormat] || audioFormat;
    const qualityArg       = buildQualityArg(audioFormat, quality);
    const usePipe          = (audioFormat === 'mp3' || audioFormat === 'wav');

    const batchDir = path.join(MP3_STORAGE_PATH, `batch_${downloadId}`);
    const zipName  = `batch_${downloadId.substring(0, 8)}.zip`;
    const zipPath  = path.join(MP3_STORAGE_PATH, zipName);

    try {
        fs.mkdirSync(batchDir, { recursive: true });
        const total    = urls.length;
        let doneCount  = 0;
        let failCount  = 0;
        const pendingRenames = [];

        const BATCH_CONCURRENCY = 3;
        const trackTasks = urls.map((rawUrl, i) => async () => {
            const cleanUrl = (typeof rawUrl === 'string') ? rawUrl : null;
            if (!cleanUrl) { doneCount++; return; }

            updateDownloadStatus(downloadId, {
                status:   `[${doneCount + 1}/${total}] Downloading...`,
                progress: 5 + Math.floor((doneCount / total) * 85),
                done: doneCount, total,
            });

            const outPattern = path.join(batchDir, `${String(i + 1).padStart(3, '0')}_%(title)s.%(ext)s`);
            let succeeded = false;

            if (usePipe) {
                const ffmpegAudioArgs = audioFormat === 'mp3'
                    ? ['-c:a', 'libmp3lame', '-b:a', `${quality}k`]
                    : ['-c:a', 'pcm_s16le'];

                const pipeDest = path.join(batchDir, `${String(i + 1).padStart(3, '0')}_track.${audioFormat}`);

                for (const strategy of DOWNLOAD_STRATEGIES) {
                    try {
                        if (fs.existsSync(pipeDest)) fs.unlinkSync(pipeDest);
                        await downloadAndEncodePiped(cleanUrl, strategy, pipeDest, ffmpegAudioArgs, false, null);
                        const renamePromise = fetchVideoInfoFast(cleanUrl).then(info => {
                            if (info?.title) {
                                const proper = path.join(batchDir, `${String(i + 1).padStart(3, '0')}_${sanitizeFilename(stripEmojis(info.title))}.${audioFormat}`);
                                try { if (fs.existsSync(pipeDest)) fs.renameSync(pipeDest, proper); } catch {}
                            }
                        }).catch(() => {});
                        pendingRenames.push(renamePromise);
                        succeeded = true;
                        break;
                    } catch (e) {
                        logger.warn(`Batch [${i+1}] pipe "${strategy.name}" failed: ${e.message.slice(0,120)}`);
                        if (fs.existsSync(pipeDest)) try { fs.unlinkSync(pipeDest); } catch {}
                    }
                }
            } else {
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
        });

        async function runPool(tasks, concurrency) {
            const iter    = tasks[Symbol.iterator]();
            const workers = Array.from({ length: concurrency }, async () => {
                for (let item = iter.next(); !item.done; item = iter.next()) {
                    await item.value();
                }
            });
            await Promise.all(workers);
        }
        await runPool(trackTasks, BATCH_CONCURRENCY);

        if (pendingRenames.length > 0) {
            updateDownloadStatus(downloadId, { status: 'Finalizing filenames...', progress: 91 });
            await Promise.allSettled(pendingRenames);
        }

        updateDownloadStatus(downloadId, { status: 'Creating zip...', progress: 93, done: doneCount, total });

        const audioFiles = fs.readdirSync(batchDir)
            .filter(f => /\.(mp3|m4a|ogg|wav|opus)$/i.test(f))
            .sort();

        if (audioFiles.length === 0) throw new Error('No tracks were downloaded successfully');

        await new Promise((resolve, reject) => {
            const output  = fs.createWriteStream(zipPath);
            const archive = archiver('zip', { zlib: { level: 0 } });
            output.on('close', resolve);
            archive.on('error', reject);
            archive.pipe(output);
            for (const fname of audioFiles) {
                archive.file(path.join(batchDir, fname), { name: fname });
            }
            archive.finalize();
        });

        try { fs.rmSync(batchDir, { recursive: true, force: true }); } catch {}

        const stat = fs.statSync(zipPath);
        if (stat.size === 0) throw new Error('Zip file is empty');

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

module.exports = {
    DOWNLOAD_STRATEGIES,
    oembedCache,
    durationCache,
    fetchVideoInfo,
    fetchPlaylistInfo,
    processYoutubeDownload,
    processPlaylistDownload,
    processBatchZip,
};
