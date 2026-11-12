// Shared by every suite whose code under test signals a PID it read from
// somewhere (pd-happier-supervise's daemon records, pd-memguard's /proc scan).
import fs from 'node:fs';

// A PID for every test that needs no real process behind it: above the
// kernel's PID_MAX_LIMIT (4194304), so no process can ever hold it, and a
// defect that signals it cannot reach anything. DO NOT plant a real PID (1, a
// spawned child's, any live one) outside the PID sandbox below: on 2026-11-03
// a `kill $pids` mutant plus a {"pid":1} stub record SIGTERMed tini and killed
// the live pocket-dev twice.
export const NO_SUCH_PID = 4194305;

// The tests that need a LIVE process at a PID the code reads, PID 1 included,
// run only inside a throwaway container started by test/pid-sandbox.sh: its
// PID 1 carries the argument "pd-pid-sandbox", which neither pocket-dev's
// docker-init nor a CI VM's systemd has, so a stray PD_PID_SANDBOX=1 is not
// enough on its own.
export const PID_SANDBOX = (() => {
  if (process.env.PD_PID_SANDBOX !== '1') return false;
  try {
    return fs.readFileSync('/proc/1/cmdline', 'utf8').split('\0').includes('pd-pid-sandbox');
  } catch {
    return false;
  }
})();
