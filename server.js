/**
 * FastMP3 Server Entry Point
 * All backend modules reside in the /backend directory.
 */

const { start } = require('./backend/index');

start();