function out(msg) {
  process.stdout.write(String(msg));
  if (!String(msg).endsWith('\n')) process.stdout.write('\n');
}

function err(msg) {
  process.stderr.write(String(msg));
  if (!String(msg).endsWith('\n')) process.stderr.write('\n');
}

function warn(msg) {
  err(`WARN: ${msg}`);
}

function info(msg) {
  err(`INFO: ${msg}`);
}

function error(msg) {
  err(`ERROR: ${msg}`);
}

function fail(msg, code = 1) {
  error(msg);
  process.exit(code);
}

module.exports = { out, err, warn, info, error, fail };
