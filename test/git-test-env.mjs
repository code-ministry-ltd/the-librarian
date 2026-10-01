// Turn off git's automatic maintenance for every git process a test starts.
//
// Since git 2.47, `git commit` launches `git maintenance run --auto` DETACHED,
// and it keeps working (taking a lock file under .git/objects) after the commit
// has returned. A test that deletes its temp vault straight after its last
// commit races that background process, and rmSync fails with
// `ENOTEMPTY: rmdir … vault/.git` — at random, and only on newer git (CI has
// 2.55). A throwaway test vault never needs maintenance, so nothing is lost.
// The vault's git calls pass process.env through, and so does every child
// process a test spawns, so setting it once per test run covers them all.
// Production is unaffected: this is only loaded by test configs and the smoke run.
//
// GIT_CONFIG_COUNT may already carry the developer's or CI's own settings
// (url rewrites, credential helpers), so these two entries are APPENDED after
// whatever is there rather than replacing it.
export function gitNoAutoMaintenanceEnv(env = process.env) {
  const existing = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10);
  const base = Number.isInteger(existing) && existing > 0 ? existing : 0;
  return {
    GIT_CONFIG_COUNT: String(base + 2),
    [`GIT_CONFIG_KEY_${base}`]: "maintenance.auto",
    [`GIT_CONFIG_VALUE_${base}`]: "false",
    [`GIT_CONFIG_KEY_${base + 1}`]: "gc.auto",
    [`GIT_CONFIG_VALUE_${base + 1}`]: "0",
  };
}

export const GIT_NO_AUTO_MAINTENANCE = gitNoAutoMaintenanceEnv();
