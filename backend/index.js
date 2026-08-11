const readline = require('readline');
const Fastify = require('fastify');
const {
    PORT,
    MP3_STORAGE_PATH,
    API_KEY_FILE,
    FILE_TTL_MS,
    QUEUE_CONCURRENCY,
    COOKIES_FILE,
    loadOrCreateApiKey,
    getApiKey
} = require('./config');
const logger = require('./logger');
const { checkDependencies, startYtDlpAutoUpdate } = require('./execEnv');
const { loadRegistry } = require('./fileRegistry');
const { startCleanupSweep } = require('./cleanupWorker');
const { oembedCache } = require('./downloadService');
const { registerRoutes } = require('./routes');

const fastify = Fastify({
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

registerRoutes(fastify);

async function start() {
    loadOrCreateApiKey(logger);
    loadRegistry();
    await checkDependencies(COOKIES_FILE);
    startCleanupSweep(oembedCache);
    startYtDlpAutoUpdate();

    try {
        await fastify.listen({ port: PORT, host: '0.0.0.0' });
        logger.success(`Server running: http://localhost:${PORT}`);
        logger.info(`Storage: ${MP3_STORAGE_PATH}`);
        logger.info(`API key: ${API_KEY_FILE}`);
        logger.info(`Queue concurrency: ${QUEUE_CONCURRENCY}`);
        logger.info(`File TTL: ${FILE_TTL_MS / 60000} minutes`);
    } catch (err) {
        logger.error('Startup error:', err);
        process.exit(1);
    }
}

async function shutdown(signal) {
    logger.warn(`Shutdown signal received: ${signal}`);
    try { await fastify.close(); logger.success('Server closed'); process.exit(0); }
    catch (e) { logger.error(e); process.exit(1); }
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on('line', (l) => { if (l.trim().toLowerCase() === 'stop') shutdown('ADMIN'); });
}

module.exports = { start, fastify, shutdown };
