const logger = {
    info:    (...a) => console.log('[INFO]', ...a),
    success: (...a) => console.log('[OK]', ...a),
    error:   (...a) => console.error('[ERROR]', ...a),
    warn:    (...a) => console.warn('[WARN]', ...a),
};

module.exports = logger;
