function parseArgs(argv, { booleanFlags = [], positionalActions = null, listFlags = [] } = {}) {
  const opts = {};
  const positional = [];
  const flatBool = new Set(booleanFlags);
  // Long flags named here accumulate every occurrence into an array instead of
  // last-wins, so `--pattern a --pattern b` → ['a','b']. Opt-in and backward
  // compatible: callers that don't pass listFlags see the original behavior.
  const listSet = new Set(listFlags);
  const actionSet = positionalActions ? new Set(positionalActions) : null;
  const actions = [];

  const pushList = (name, value) => {
    if (!Array.isArray(opts[name])) opts[name] = [];
    opts[name].push(value);
  };

  let i = 0;
  while (i < argv.length) {
    const token = argv[i];

    if (token === '-h' || token === '--help') {
      opts.help = true;
      i++;
      continue;
    }

    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      let name;
      let value;
      if (eq !== -1) {
        name = token.slice(2, eq);
        value = token.slice(eq + 1);
        if (listSet.has(name)) pushList(name, value);
        else opts[name] = value;
        i++;
        continue;
      }
      name = token.slice(2);
      if (flatBool.has(name)) {
        opts[name] = true;
        i++;
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        opts[name] = true;
        i++;
      } else if (listSet.has(name)) {
        pushList(name, next);
        i += 2;
      } else {
        opts[name] = next;
        i += 2;
      }
      continue;
    }

    if (token.startsWith('-') && token.length === 2) {
      const name = token.slice(1);
      const next = argv[i + 1];
      if (flatBool.has(name)) {
        opts[name] = true;
        i++;
        continue;
      }
      if (next === undefined || next.startsWith('-')) {
        opts[name] = true;
        i++;
      } else {
        opts[name] = next;
        i += 2;
      }
      continue;
    }

    if (actionSet?.has(token)) {
      actions.push(token);
    } else {
      positional.push(token);
    }
    i++;
  }

  return { opts, positional, actions };
}

module.exports = { parseArgs };
