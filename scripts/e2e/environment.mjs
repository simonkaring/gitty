export function isolatedEnvironment(source, additions = {}) {
  const clean = Object.fromEntries(Object.entries(source).filter(([key]) => {
    const name = key.toUpperCase();
    return !name.startsWith('GIT_') &&
      !name.startsWith('GITTY_') &&
      name !== 'EDITOR' &&
      name !== 'VISUAL' &&
      !name.endsWith('_EDITOR') &&
      !name.endsWith('_ASKPASS');
  }));
  return {
    ...clean,
    ...Object.fromEntries(Object.entries(additions).filter(([, value]) => value !== undefined)),
  };
}
