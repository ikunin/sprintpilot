let clackPromise;

function loadClack() {
  if (!clackPromise) {
    clackPromise = import('@clack/prompts');
  }
  return clackPromise;
}

async function multiselect(opts) {
  const clack = await loadClack();
  const result = await clack.multiselect(opts);
  if (clack.isCancel(result)) {
    clack.cancel('Cancelled');
    process.exit(0);
  }
  return result;
}

async function confirm(opts) {
  const clack = await loadClack();
  const result = await clack.confirm(opts);
  if (clack.isCancel(result)) {
    clack.cancel('Cancelled');
    process.exit(0);
  }
  return result;
}

async function intro(message) {
  const clack = await loadClack();
  clack.intro(message);
}

async function outro(message) {
  const clack = await loadClack();
  clack.outro(message);
}

async function note(message, title) {
  const clack = await loadClack();
  clack.note(message, title);
}

const log = {
  async info(message) {
    const clack = await loadClack();
    clack.log.info(message);
  },
  async success(message) {
    const clack = await loadClack();
    clack.log.success(message);
  },
  async warn(message) {
    const clack = await loadClack();
    clack.log.warn(message);
  },
  async error(message) {
    const clack = await loadClack();
    clack.log.error(message);
  },
  async step(message) {
    const clack = await loadClack();
    clack.log.step(message);
  },
  async message(message) {
    const clack = await loadClack();
    clack.log.message(message);
  },
};

module.exports = {
  loadClack,
  intro,
  outro,
  note,
  multiselect,
  confirm,
  log,
};
