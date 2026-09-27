#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { main } from '../update-deps.mjs';

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === entry) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
