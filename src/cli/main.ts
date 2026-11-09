#!/usr/bin/env node
import { runCli } from './commands.js';

// process.exit는 파이프에 남은 stdout을 버릴 수 있다
process.exitCode = runCli(process.argv.slice(2));
