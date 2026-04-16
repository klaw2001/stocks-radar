'use strict';

const path = require('path');
const fs   = require('fs');

const logStream = fs.createWriteStream(
  path.join(__dirname, '..', 'concall_monitor.log'),
  { flags: 'a' }
);

function log(tag, msg, ...args) {
  const ts   = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = args.length
    ? `[${ts}] [${tag}] ${msg} ${args.join(' ')}`
    : `[${ts}] [${tag}] ${msg}`;
  console.log(line);
  logStream.write(line + '\n');
}

function logErr(tag, msg, ...args) {
  const ts   = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = args.length
    ? `[${ts}] [${tag}] ❌ ${msg} ${args.join(' ')}`
    : `[${ts}] [${tag}] ❌ ${msg}`;
  console.error(line);
  logStream.write(line + '\n');
}

module.exports = { log, logErr };
