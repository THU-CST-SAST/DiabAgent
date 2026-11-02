// Live service entry point (kept at this path for scripts/deploy.js and `npm start`).
// The implementation lives in src/live/; this file only re-exports it and starts it when run.
import {fileURLToPath} from 'node:url';
import {startFromEnv} from './live/index.mjs';

export {createApp,startLiveServer,startFromEnv,Store,LiveService,PatientService,Relay,RelayRequestError,viewSnapshot} from './live/index.mjs';

if(process.argv[1]===fileURLToPath(import.meta.url))await startFromEnv();
