import { startRelayServer } from './server.js';

startRelayServer();

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
