const path = require('path');
const fs = require('fs');
const { MP3_STORAGE_PATH, CACHE_DIR, FILE_TTL_MS } = require('./config');
const logger = require('./logger');

if (!fs.existsSync(MP3_STORAGE_PATH)) {
    fs.mkdirSync(MP3_STORAGE_PATH, { recursive: true });
    logger.success(`Storage created: ${MP3_STORAGE_PATH}`);
}
if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}

const REGISTRY_PATH = path.join(MP3_STORAGE_PATH, '.registry.json');
const fileRegistry = new Map();

let _registrySaveTimer = null;

function saveRegistry(immediate = false) {
    if (_registrySaveTimer) clearTimeout(_registrySaveTimer);
    const flush = () => {
        try {
            const obj = {};
            for (const [k, v] of fileRegistry) obj[k] = v;
            fs.writeFileSync(REGISTRY_PATH, JSON.stringify(obj));
        } catch {}
    };
    if (immediate) { flush(); return; }
    _registrySaveTimer = setTimeout(flush, 2000);
}

function loadRegistry() {
    try {
        if (fs.existsSync(REGISTRY_PATH)) {
            const raw = fs.readFileSync(REGISTRY_PATH, 'utf8');
            const obj = JSON.parse(raw);
            const now = Date.now();
            for (const [k, v] of Object.entries(obj)) {
                if (v > now) fileRegistry.set(k, v);
            }
            logger.info(`Registry loaded: ${fileRegistry.size} tracked files`);
        }
    } catch {}
}

function registerFile(filePath) {
    if (!filePath) return;
    const name = path.basename(filePath);
    const expiresAt = Date.now() + FILE_TTL_MS;
    fileRegistry.set(name, expiresAt);
    saveRegistry();
}

function renewFile(filePath) {
    if (!filePath) return;
    const name = path.basename(filePath);
    if (fileRegistry.has(name)) {
        fileRegistry.set(name, Date.now() + FILE_TTL_MS);
        saveRegistry();
    }
}

function getFileExpiresAt(filename) {
    return fileRegistry.get(filename) || null;
}

module.exports = {
    fileRegistry,
    loadRegistry,
    saveRegistry,
    registerFile,
    renewFile,
    getFileExpiresAt,
};
