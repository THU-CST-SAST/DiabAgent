#!/usr/bin/env node
import {runCli} from '../../../sweet-sim/scripts/build-scenario-version.mjs';
runCli(process.argv.slice(2),{version:'v4.0'});
