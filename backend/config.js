const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT, 10) || 3556;
const ROOT_DIR = path.resolve(__dirname, '..');
const MP3_STORAGE_PATH = path.join(ROOT_DIR, 'temp', 'mp3');
const WEB_ROOT = path.join(ROOT_DIR, 'web');
const CACHE_DIR = path.join(MP3_STORAGE_PATH, '.cache');

const MAX_REQUESTS = parseInt(process.env.MAX_REQUESTS, 10) || 100;
const TIME_WINDOW = parseInt(process.env.TIME_WINDOW, 10) || 60000; // 1 min
const FILE_TTL_MS = 60 * 60 * 1000; // 1 hour
const QUEUE_CONCURRENCY = parseInt(process.env.QUEUE_CONCURRENCY, 10) || 2;
const MAX_DOWNLOADS_PER_IP = parseInt(process.env.MAX_DOWNLOADS_PER_IP, 10) || 3;
const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/+$/, '');

const COOKIES_FILE = (() => {
    const p = process.env.COOKIES_FILE || process.env.YT_COOKIES || '/home/homemc/ytcookie.txt';
    try { return fs.existsSync(p) ? p : null; } catch { return null; }
})();

const API_KEY_FILE = path.join(ROOT_DIR, '.apikey');
let API_KEY = '';

function loadOrCreateApiKey(logger) {
    try {
        if (fs.existsSync(API_KEY_FILE)) {
            API_KEY = fs.readFileSync(API_KEY_FILE, 'utf8').trim();
            if (API_KEY.length >= 32) return API_KEY;
        }
    } catch {}
    API_KEY = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(API_KEY_FILE, API_KEY, { mode: 0o600 });
    if (logger) logger.success(`Generated new API key: ${API_KEY_FILE}`);
    return API_KEY;
}

function getApiKey() {
    return API_KEY;
}

module.exports = {
    PORT,
    ROOT_DIR,
    MP3_STORAGE_PATH,
    WEB_ROOT,
    CACHE_DIR,
    MAX_REQUESTS,
    TIME_WINDOW,
    FILE_TTL_MS,
    QUEUE_CONCURRENCY,
    MAX_DOWNLOADS_PER_IP,
    BASE_PATH,
    COOKIES_FILE,
    API_KEY_FILE,
    loadOrCreateApiKey,
    getApiKey,
};
