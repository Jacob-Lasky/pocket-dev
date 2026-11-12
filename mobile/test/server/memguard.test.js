import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnEnv } from './pdEnv.js';
import { NO_SUCH_PID, PID_SANDBOX } from './pidSandbox.js';

// pd-memguard, the user-space OOM backstop entrypoint.sh starts (see the script
// header for why it exists and why not earlyoom or PSI).
//
// The guard reads a /proc-shaped tree and a cgroup directory through test
// seams, so every case here runs it against a FAKE tree. The only real PIDs
// that tree ever names are this test's own children, which is what makes it
// safe to run anywhere: a defect or a mutant can only signal a process the
// test started, or a PID above the kernel's limit (NO_SUCH_PID). DO NOT name
// PID 1 or any PID the test did not start outside the PID sandbox block at the
// bottom (pidSandbox.js has the 2026-11-03 incident).

const ROOT = path.resolve(__dirname, '../../..');
const GUARD = path.join(ROOT, 'mobile/pd-memguard');
const ENTRYPOINT = path.join(ROOT, 'entrypoint.sh');
const DOCKERFILE = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
const UID = process.getuid();
const GiB = 1024 * 1024; // in kB, the unit /proc/<pid>/status uses
const LIMIT_BYTES = 16 * 1024 ** 3;

let tmproot, procDir, cgroupDir, logFile, children;

beforeEach(() => {
  tmproot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-memguard-'));
  procDir = path.join(tmproot, 'proc');
  cgroupDir = path.join(tmproot, 'cgroup');
  logFile = path.join(tmproot, 'memguard.log');
  fs.mkdirSync(procDir);
  fs.mkdirSync(cgroupDir);
  children = [];
});

afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  fs.rmSync(tmproot, { recursive: true, force: true });
});

// The cgroup's memory.max and memory.stat. `anonKb` is what the guard counts.
function cgroup({ max = String(LIMIT_BYTES), anonKb }) {
  if (max !== null) fs.writeFileSync(path.join(cgroupDir, 'memory.max'), `${max}\n`);
  fs.writeFileSync(
    path.join(cgroupDir, 'memory.stat'),
    `anon ${anonKb * 1024}\nfile 1073741824\nkernel 0\nshmem 0\nslab_reclaimable 0\n`,
  );
}
const full = () => cgroup({ anonKb: 15 * GiB }); // within the default 2 GiB reserve of 16 GiB
const roomy = () => cgroup({ anonKb: 4 * GiB });

// A stat line whose field 3 is `state` and field 22 is `start`, with a command
// name holding a space and a ") " to prove fields are counted from the last one.
const statLine = (pid, start, state = 'S') =>
  `${pid} (odd ) name) ${state} ${Array(18).fill('0').join(' ')} ${start} 0 0\n`;

// One fake /proc/<pid>. `stat: 'real'` links to the live process's own stat, so
// its start time and zombie state are the kernel's; anything else is written.
function procEntry(pid, { rssKb, cmd, uid = UID, stat = 'real' }) {
  const dir = path.join(procDir, String(pid));
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'status'), `Name:\tx\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\nRssAnon:\t ${rssKb} kB\n`);
  fs.writeFileSync(path.join(dir, 'cmdline'), cmd.split(' ').map((a) => `${a}\0`).join(''));
  if (stat === 'real') fs.symlinkSync(`/proc/${pid}/stat`, path.join(dir, 'stat'));
  else fs.writeFileSync(path.join(dir, 'stat'), stat);
  return dir;
}

function child(args) {
  const c = spawn(args[0], args.slice(1), { stdio: ['ignore', 'pipe', 'ignore'] });
  children.push(c);
  return c;
}
const sleeper = () => child(['sleep', '30']);
// Ignores SIGTERM, so only SIGKILL ends it. Ignored signals survive exec, so
// the sleeps it runs ignore it too.
const stubborn = () => child(['bash', '-c', 'trap "" TERM; while :; do sleep 0.2; done']);
const isRunning = (c) => c.exitCode === null && c.signalCode === null;

function exited(c, ms = 3000) {
  if (!isRunning(c)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    c.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

// One evaluation (PD_MEMGUARD_ONCE): exit 0 after a kill, 1 otherwise. Spawned
// asynchronously so node reaps the children the guard kills while it waits.
function runGuard(env = {}) {
  return new Promise((resolve, reject) => {
    const g = spawn('bash', [GUARD], {
      env: spawnEnv({
        PD_MEMGUARD_CGROUP: cgroupDir,
        PD_MEMGUARD_PROC: procDir,
        PD_MEMGUARD_ONCE: '1',
        PD_MEMGUARD_GRACE: '1',
        PD_MEMGUARD_LOG: logFile,
        ...env,
      }),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    g.stderr.on('data', (d) => (stderr += d));
    g.on('error', reject);
    g.on('close', (code) => resolve({ code, stderr, log: fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '' }));
  });
}

describe('pd-memguard', () => {
  it('kills the largest unprotected same-user process and nothing else', async () => {
    full();
    const big = sleeper();
    const smaller = sleeper();
    procEntry(big.pid, { rssKb: 3 * GiB, cmd: 'grep -o [^"]{0,1500}X[^"]{0,1500} big.jsonl' });
    procEntry(smaller.pid, { rssKb: 1.5 * GiB, cmd: 'node build.js' });
    // Bigger, but never candidates. Their PIDs cannot exist, so a defect that
    // picks one signals nothing and the assertions below catch it.
    let fake = NO_SUCH_PID;
    for (const cmd of [
      '/home/claude/.happier/cli/versions/0.2.20/happier daemon start-sync', // the Happier daemon
      // the same daemon from the image's npm fallback (its spawnHappyCLI shape)
      'node --no-warnings --no-deprecation /opt/agent-tools/node_modules/@happier-dev/cli/package-dist/index.mjs daemon start-sync',
      '/bin/bash /mobile/pd-happier-supervise',
      '/bin/bash /mobile/pd-memguard',
      'node /mobile/server.js', // the terminal server
      'tmux -u -f /mobile/tmux.conf new-session -A -s main-1', // the server keeps its client's argv
      'tmux: server', // or carries tmux's own title
    ]) {
      procEntry(fake++, { rssKb: 8 * GiB, cmd, stat: statLine(fake, 1) });
    }
    procEntry(fake++, { rssKb: 9 * GiB, cmd: 'someone else', uid: UID + 1, stat: statLine(fake, 1) });
    procEntry(fake++, { rssKb: 10 * GiB, cmd: '', stat: statLine(fake, 1) }); // a kernel thread

    const { code, log } = await runGuard();
    expect(code).toBe(0);
    expect(log).toContain(`killing pid ${big.pid} (${3 * GiB} kB anon): grep -o`);
    expect(await exited(big)).toBe(true);
    expect(big.signalCode).toBe('SIGTERM');
    expect(isRunning(smaller)).toBe(true);
    expect(log).not.toContain('SIGKILL');
  });

  it('passes over a candidate whose start time cannot be read and takes the next one', async () => {
    full();
    const next = sleeper();
    procEntry(next.pid, { rssKb: 2 * GiB, cmd: 'node build.js' });
    // Bigger, but it exited between the status and stat reads: no stat file.
    const gone = procEntry(NO_SUCH_PID, { rssKb: 6 * GiB, cmd: 'grep x', stat: statLine(NO_SUCH_PID, 1) });
    fs.rmSync(path.join(gone, 'stat'));
    const { code, log } = await runGuard();
    expect(code).toBe(0);
    expect(log).toContain(`killing pid ${next.pid}`);
    expect(log).not.toContain(`killing pid ${NO_SUCH_PID}`);
    expect(await exited(next)).toBe(true);
  });

  it('reads the start time of a process whose name holds a newline, so SIGTERM still escalates', async () => {
    full();
    const victim = stubborn();
    // Linux allows any byte but NUL in a command name (prctl PR_SET_NAME).
    const stat = `${victim.pid} (two\nlines) S ${Array(18).fill('0').join(' ')} 111 0 0\n`;
    procEntry(victim.pid, { rssKb: 3 * GiB, cmd: 'bash -c stubborn', stat });
    const { code, log } = await runGuard();
    expect(code).toBe(0);
    expect(log).toContain(`pid ${victim.pid} ignored SIGTERM for 1s; sent SIGKILL`);
    expect(await exited(victim)).toBe(true);
    expect(victim.signalCode).toBe('SIGKILL');
  });

  it('signals nothing when the chosen process is gone by the time it would be signalled', async () => {
    full();
    const bystander = sleeper();
    // Chosen, then found to be a zombie at the check right before SIGTERM:
    // the same check that keeps a reused PID from being signalled.
    procEntry(bystander.pid, { rssKb: 3 * GiB, cmd: 'grep x', stat: statLine(bystander.pid, 111, 'Z') });
    const { code, log } = await runGuard();
    expect(code).toBe(1);
    expect(log).toContain(`pid ${bystander.pid} exited before it could be signalled`);
    expect(log).not.toContain('killing');
    expect(isRunning(bystander)).toBe(true);
  });

  it('checks identity again after logging, so a PID reused while the log write stalled is not signalled', async () => {
    // The kill line is logged after the first identity check and before
    // SIGTERM, and a log write can block. Two FIFOs make that stall
    // deterministic: memory.max holds the guard until the test has filled the
    // log pipe, so the kill line's write blocks, and the PID is "reused" (its
    // start time changes) while it does.
    //
    // DO NOT stall it by closing the log reader instead (a blocked open). Any
    // child another test file in this process forks inherits the reader until
    // its exec, and while it does the guard's open succeeds, its line goes to
    // that copy and is lost, and nothing stalls (seen in the full suite,
    // 2026-11-12). A full pipe stalls the write whoever else holds the FIFO.
    cgroup({ max: null, anonKb: 15 * GiB });
    const maxFifo = path.join(cgroupDir, 'memory.max');
    const logFifo = path.join(tmproot, 'memguard.fifo');
    for (const f of [maxFifo, logFifo]) expect(spawnSync('mkfifo', [f]).status).toBe(0);
    const bystander = sleeper();
    const dir = procEntry(bystander.pid, { rssKb: 3 * GiB, cmd: 'grep x', stat: statLine(bystander.pid, 111) });
    const openReader = () => fs.openSync(logFifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const drain = (fd) => {
      const buf = Buffer.alloc(4096);
      let out = '';
      for (;;) {
        let n;
        try {
          n = fs.readSync(fd, buf, 0, buf.length, null);
        } catch (e) {
          if (e.code === 'EAGAIN') return out;
          throw e;
        }
        if (n === 0) return out;
        out += buf.toString('utf8', 0, n);
      }
    };
    const reader = openReader(); // before the guard starts, and held open throughout
    const FILL = '#'; // filler byte, never in a guard line
    const fill = () => {
      const w = fs.openSync(logFifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
      for (const chunk of [Buffer.alloc(4096, FILL), Buffer.from(FILL)]) {
        for (;;) {
          try {
            fs.writeSync(w, chunk);
          } catch (e) {
            if (e.code === 'EAGAIN') break;
            throw e;
          }
        }
      }
      fs.closeSync(w); // the reader keeps what was written
    };
    const g = spawn('bash', [GUARD], {
      env: spawnEnv({
        PD_MEMGUARD_CGROUP: cgroupDir,
        PD_MEMGUARD_PROC: procDir,
        PD_MEMGUARD_ONCE: '1',
        PD_MEMGUARD_GRACE: '1',
        PD_MEMGUARD_LOG: logFifo,
      }),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    children.push(g);
    let stderr = '';
    g.stderr.on('data', (d) => (stderr += d));
    let code;
    g.on('close', (c) => (code = c));
    const until = async (done, what) => {
      const end = Date.now() + 5000;
      while (!done()) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}; stderr: ${stderr}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    };

    let log = '';
    await until(() => (log += drain(reader)).includes('started'), 'the started line in the log');
    fill(); // the log pipe is full: the guard's next log write blocks
    const w = fs.openSync(maxFifo, 'w'); // releases the guard's read of memory.max
    fs.writeSync(w, `${LIMIT_BYTES}\n`);
    fs.closeSync(w);
    await until(() => stderr.includes(`killing pid ${bystander.pid}`), 'the kill line on stderr');
    fs.writeFileSync(path.join(dir, 'stat'), statLine(bystander.pid, 222)); // the PID now names another process
    await until(() => {
      log += drain(reader); // makes room, so the stalled log write finishes
      return code !== undefined;
    }, 'the guard to exit');
    log += drain(reader);
    fs.closeSync(reader);
    log = log.replaceAll(FILL, '');

    expect(code, `stderr:\n${stderr}\nlog:\n${log}`).toBe(1);
    expect(log).toContain(`killing pid ${bystander.pid}`);
    expect(log).toContain(`pid ${bystander.pid} exited before it could be signalled`);
    expect(isRunning(bystander)).toBe(true);
  });

  it('kills nothing while there is room below the reserve', async () => {
    roomy();
    const big = sleeper();
    procEntry(big.pid, { rssKb: 3 * GiB, cmd: 'grep x' });
    const { code, log } = await runGuard();
    expect(code).toBe(1);
    expect(log).not.toContain('killing');
    expect(isRunning(big)).toBe(true);
  });

  it('leaves a full cgroup to the kernel when no process is big enough to be a runaway', async () => {
    full();
    const session = sleeper();
    procEntry(session.pid, { rssKb: 400 * 1024, cmd: 'claude --resume x' }); // an ordinary session
    const { code, log } = await runGuard();
    expect(code).toBe(1);
    expect(log).toContain('no process reaches 1048576 kB; leaving it to the kernel');
    expect(isRunning(session)).toBe(true);
  });

  it('does nothing when the cgroup has no limit', async () => {
    cgroup({ max: 'max', anonKb: 15 * GiB });
    const big = sleeper();
    procEntry(big.pid, { rssKb: 3 * GiB, cmd: 'grep x' });
    expect((await runGuard()).code).toBe(1);
    fs.rmSync(path.join(cgroupDir, 'memory.max'));
    expect((await runGuard()).code).toBe(1);
    expect(isRunning(big)).toBe(true);
  });

  it('sends SIGKILL when SIGTERM is ignored', async () => {
    full();
    const victim = stubborn();
    procEntry(victim.pid, { rssKb: 3 * GiB, cmd: 'bash -c stubborn' });
    const { code, log } = await runGuard();
    expect(code).toBe(0);
    expect(log).toContain(`pid ${victim.pid} ignored SIGTERM for 1s; sent SIGKILL`);
    expect(await exited(victim)).toBe(true);
    expect(victim.signalCode).toBe('SIGKILL');
  });

  it('counts a zombie as gone: no SIGKILL and no "ignored SIGTERM" for a process that obeyed', async () => {
    full();
    // `exec sleep` replaces the shell with a parent that never waits, so the
    // background sleep stays a zombie after the guard's SIGTERM ends it.
    const holder = child(['bash', '-c', 'sleep 30 & echo $!; exec sleep 30']);
    const pid = Number(await new Promise((resolve) => holder.stdout.once('data', (d) => resolve(String(d).trim()))));
    procEntry(pid, { rssKb: 3 * GiB, cmd: 'sleep 30' });
    const { code, log } = await runGuard({ PD_MEMGUARD_GRACE: '2' });
    expect(code).toBe(0);
    expect(log).toContain(`killing pid ${pid}`);
    expect(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')).toMatch(/\) Z /);
    expect(log).not.toContain('ignored SIGTERM');
  });

  it('does not SIGKILL a PID that now belongs to a different process', async () => {
    full();
    const victim = stubborn();
    const dir = procEntry(victim.pid, { rssKb: 3 * GiB, cmd: 'bash -c stubborn', stat: statLine(victim.pid, 111) });
    const run = runGuard({ PD_MEMGUARD_GRACE: '3' });
    // Once the SIGTERM is out, the PID "is reused": same number, new start time.
    for (let i = 0; i < 100 && !(fs.existsSync(logFile) && fs.readFileSync(logFile, 'utf8').includes('killing pid')); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    fs.writeFileSync(path.join(dir, 'stat'), statLine(victim.pid, 222));
    const { code, log } = await run;
    expect(code).toBe(0);
    expect(log).toContain(`killing pid ${victim.pid}`);
    expect(log).not.toContain('SIGKILL');
    expect(isRunning(victim)).toBe(true);
  });

  // PID 1 in the fake tree. PID sandbox ONLY (pidSandbox.js): there, PID 1 is
  // the throwaway container's, so a defect that signals it ends that container
  // and not pocket-dev. Run with `test/pid-sandbox.sh`.
  describe.skipIf(!PID_SANDBOX)('with PID 1 the biggest candidate (PID sandbox)', () => {
    it('never signals PID 1', async () => {
      full();
      const big = sleeper();
      procEntry(1, { rssKb: 12 * GiB, cmd: '/bin/bash -c runaway' });
      procEntry(big.pid, { rssKb: 3 * GiB, cmd: 'grep x' });
      const { code, log } = await runGuard();
      expect(code).toBe(0);
      expect(log).toContain(`killing pid ${big.pid}`);
      expect(log).not.toMatch(/killing pid 1 /);
    });
  });
});

describe('entrypoint.sh starts pd-memguard', () => {
  function boot(env) {
    const marker = path.join(tmproot, 'launched');
    const stub = path.join(tmproot, 'memguard-stub');
    fs.writeFileSync(stub, `#!/bin/bash\ntouch "${marker}"\n`);
    fs.chmodSync(stub, 0o755);
    const home = path.join(tmproot, 'home');
    fs.mkdirSync(home);
    fs.mkdirSync(path.join(tmproot, 'skel/.local/share'), { recursive: true });
    const vars = spawnEnv({
      HOME: home,
      PD_SKEL_DIR: path.join(tmproot, 'skel'),
      PD_CACHE_DIR: path.join(tmproot, 'cache'),
      PD_MEMGUARD_BIN: stub,
      ...env,
    });
    // spawnEnv turns it off for every other suite; unset is the production default.
    if (env.PD_MEMGUARD === undefined) delete vars.PD_MEMGUARD;
    const res = spawnSync('bash', [ENTRYPOINT, 'sleep', '0.3'], { env: vars, encoding: 'utf8' });
    expect(res.status).toBe(0);
    return fs.existsSync(marker);
  }

  it('launches it by default', () => {
    expect(boot({})).toBe(true);
  });

  it('honours PD_MEMGUARD=0', () => {
    expect(boot({ PD_MEMGUARD: '0' })).toBe(false);
  });

  it('ships it in the image, executable', () => {
    expect(DOCKERFILE).toMatch(/sed -i 's\/\\r\/\/' [^\n]*pd-memguard/);
    expect(DOCKERFILE).toMatch(/chmod \+x [^\n]*\/mobile\/pd-memguard/);
    expect(fs.statSync(GUARD).mode & 0o111).not.toBe(0);
  });
});
