const https = require('https');
const http = require('http');

const httpsAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 15000,
    maxSockets: 3,
    maxFreeSockets: 1,
    timeout: 6000,
    scheduling: 'lifo',
    family: 4,
});

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
        .replace(/[\/\\:*?"<>|\0\r\n\t]/g, '')
        .replace(/\.{2,}/g, '.')
        .replace(/^[\s.]+|[\s.]+$/g, '')
        .substring(0, 200) || 'download';
}

function cleanYoutubeUrl(url) {
    if (typeof url !== 'string') return null;
    try {
        const u = new URL(url);
        if (!/^(www\.)?(youtube\.com|youtu\.be|music\.youtube\.com)$/i.test(u.hostname)) return null;
        return u.href;
    } catch { return null; }
}

function isValidYouTubeUrl(url) {
    if (typeof url !== 'string') return false;
    try {
        const u = new URL(url);
        return /^(www\.)?(youtube\.com|youtu\.be|music\.youtube\.com)$/i.test(u.hostname);
    } catch { return false; }
}

function extractVideoId(url) {
    try {
        const u = new URL(url);
        if (u.hostname.includes('youtu.be')) return u.pathname.slice(1).split('?')[0];
        return u.searchParams.get('v') || null;
    } catch { return null; }
}

function isPlaylistUrl(url) {
    try {
        const u = new URL(url);
        return u.searchParams.has('list') && !u.searchParams.has('v');
    } catch { return false; }
}

function getMimeType(ext) {
    const map = {
        mp3: 'audio/mpeg',
        ogg: 'audio/ogg',
        wav: 'audio/wav',
        m4a: 'audio/mp4',
        zip: 'application/zip'
    };
    return map[ext] || 'application/octet-stream';
}

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

function httpGetText(url, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const mod   = url.startsWith('https') ? https : http;
        const agent = url.startsWith('https') ? httpsAgent : undefined;
        const req   = mod.get(url, {
            timeout: timeoutMs, agent,
            headers: {
                'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'identity',
            }
        }, (res) => {
            if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
            let body = '';
            res.on('data', d => body += d);
            res.on('end', () => resolve(body));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
}

module.exports = {
    stripEmojis,
    sanitizeFilename,
    cleanYoutubeUrl,
    isValidYouTubeUrl,
    extractVideoId,
    isPlaylistUrl,
    getMimeType,
    httpGet,
    httpGetText,
};
