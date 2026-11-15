import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnEnv } from './pdEnv.js';

// pd-sshd, the key-only outage sshd entrypoint.sh starts (see the script
// header for why it exists, Multica WORK-332). Every case runs it with
// PD_SSHD_ONCE=1 and a stub sshd/ssh-keygen, so nothing listens on a port and
// nothing outlives the test. The real-sshd block at the bottom only runs where
// /usr/sbin/sshd exists (the image), and only validates the config with -t.

const ROOT = path.resolve(__dirname, '../../..');
const SCRIPT = path.join(ROOT, 'mobile/pd-sshd');
const ENTRYPOINT = path.join(ROOT, 'entrypoint.sh');
const DOCKERFILE = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
const TEMPLATE = fs.readFileSync(path.join(ROOT, 'pocket-dev.xml'), 'utf8');
const REAL_SSHD = '/usr/sbin/sshd';

let tmp, home, state, calls;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-sshd-'));
  home = path.join(tmp, 'home');
  state = path.join(tmp, 'state');
  calls = path.join(tmp, 'calls');
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true, mode: 0o700 });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function stub(name, body) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, `#!/bin/bash\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

function run({ sshdBody = 'exit 0', env = {} } = {}) {
  const sshd = stub('sshd', `echo "$*" >> "${calls}"\n${sshdBody}`);
  // Writes the key pair at -f, as ssh-keygen does.
  const keygen = stub(
    'keygen',
    'while [ $# -gt 0 ]; do [ "$1" = -f ] && f=$2; shift; done; echo priv > "$f"; echo pub > "$f.pub"',
  );
  return spawnSync('bash', [SCRIPT], {
    env: spawnEnv({
      HOME: home,
      PD_SSHD_DIR: state,
      PD_SSHD_BIN: sshd,
      PD_SSHD_KEYGEN: keygen,
      PD_SSHD_ONCE: '1',
      ...env,
    }),
    encoding: 'utf8',
  });
}

const authorize = () => fs.writeFileSync(path.join(home, '.ssh/authorized_keys'), 'ssh-ed25519 AAAA test\n');
const config = () => fs.readFileSync(path.join(state, 'sshd_config'), 'utf8');
const directive = (name) => (config().match(new RegExp(`^${name} (.*)$`, 'm')) || [])[1];

describe('pd-sshd', () => {
  it('does not start sshd while there is no authorized_keys', () => {
    const res = run();
    expect(res.status).toBe(3);
    expect(fs.existsSync(calls)).toBe(false);
    expect(fs.existsSync(path.join(state, 'sshd_config'))).toBe(false);
  });

  it('validates, then runs sshd in the foreground on its own config', () => {
    authorize();
    const res = run();
    expect(res.status).toBe(0);
    const lines = fs.readFileSync(calls, 'utf8').trim().split('\n');
    const cfg = path.join(state, 'sshd_config');
    expect(lines).toEqual([`-t -f ${cfg}`, `-D -e -f ${cfg}`]);
  });

  it('writes a key-only, no-forwarding, unprivileged config', () => {
    authorize();
    run();
    expect(directive('Port')).toBe('2222');
    expect(directive('PasswordAuthentication')).toBe('no');
    expect(directive('KbdInteractiveAuthentication')).toBe('no');
    expect(directive('PermitRootLogin')).toBe('no');
    expect(directive('UsePAM')).toBe('no');
    expect(directive('AllowTcpForwarding')).toBe('no');
    expect(directive('AllowAgentForwarding')).toBe('no');
    expect(directive('GatewayPorts')).toBe('no');
    expect(directive('AuthorizedKeysFile')).toBe(path.join(home, '.ssh/authorized_keys'));
    expect(directive('HostKey')).toBe(path.join(state, 'ssh_host_ed25519_key'));
    expect(directive('SetEnv')).toMatch(/^PATH=\S+ /);
  });

  it('keeps the host key across restarts and never makes the state readable by others', () => {
    authorize();
    run();
    const key = path.join(state, 'ssh_host_ed25519_key');
    fs.writeFileSync(key, 'existing\n');
    run();
    expect(fs.readFileSync(key, 'utf8')).toBe('existing\n');
    expect(fs.statSync(state).mode & 0o077).toBe(0);
  });

  it('removes group and other write from the home, ~/.ssh and authorized_keys so StrictModes accepts the key', () => {
    authorize();
    const keys = path.join(home, '.ssh/authorized_keys');
    fs.chmodSync(home, 0o775);
    fs.chmodSync(path.join(home, '.ssh'), 0o777);
    fs.chmodSync(keys, 0o666);
    const res = run();
    expect(res.status).toBe(0);
    expect(fs.statSync(home).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(home, '.ssh')).mode & 0o777).toBe(0o755);
    expect(fs.statSync(keys).mode & 0o777).toBe(0o644);
    expect(res.stderr).toMatch(/removed group\/other write from .*home \(was 775/);
  });

  it('leaves already-safe modes alone and says nothing', () => {
    authorize();
    fs.chmodSync(home, 0o750);
    const res = run();
    expect(fs.statSync(home).mode & 0o777).toBe(0o750);
    expect(res.stderr).not.toMatch(/removed group/);
  });

  it('does not run sshd when sshd -t rejects the config', () => {
    authorize();
    const res = run({ sshdBody: '[ "$1" = -t ] && { echo bad config >&2; exit 255; }; exit 0' });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/sshd rejects .*bad config/);
    expect(fs.readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it.skipIf(!fs.existsSync(REAL_SSHD))('produces a config the real sshd accepts', () => {
    authorize();
    const res = run({ env: { PD_SSHD_KEYGEN: 'ssh-keygen' } });
    expect(res.status).toBe(0);
    const check = spawnSync(REAL_SSHD, ['-t', '-f', path.join(state, 'sshd_config')], { encoding: 'utf8' });
    expect(check.stderr).toBe('');
    expect(check.status).toBe(0);
  });
});

describe('entrypoint.sh starts pd-sshd', () => {
  function boot(env) {
    const marker = path.join(tmp, 'launched');
    const sup = stub('sshd-supervisor', `touch "${marker}"`);
    fs.mkdirSync(path.join(tmp, 'skel/.local/share'), { recursive: true });
    const vars = spawnEnv({
      HOME: home,
      PD_SKEL_DIR: path.join(tmp, 'skel'),
      PD_CACHE_DIR: path.join(tmp, 'cache'),
      PD_SSHD_SUPERVISOR: sup,
      ...env,
    });
    // spawnEnv turns it off for every other suite; unset is the production default.
    if (env.PD_SSHD === undefined) delete vars.PD_SSHD;
    const res = spawnSync('bash', [ENTRYPOINT, 'sleep', '0.3'], { env: vars, encoding: 'utf8' });
    expect(res.status).toBe(0);
    return fs.existsSync(marker);
  }

  it('launches it by default', () => {
    expect(boot({})).toBe(true);
  });

  it('honours PD_SSHD=0', () => {
    expect(boot({ PD_SSHD: '0' })).toBe(false);
  });

  it('ships it in the image, executable, with the server and no baked host keys', () => {
    expect(DOCKERFILE).toMatch(/sed -i 's\/\\r\/\/' [^\n]*pd-sshd/);
    expect(DOCKERFILE).toMatch(/chmod \+x [^\n]*\/mobile\/pd-sshd/);
    expect(DOCKERFILE).toMatch(/install -y --no-install-recommends openssh-server/);
    expect(DOCKERFILE).toMatch(/rm -f \/etc\/ssh\/ssh_host_\*/);
    expect(fs.statSync(SCRIPT).mode & 0o111).not.toBe(0);
  });

  it('publishes the port on the docker bridge gateway only, never every interface', () => {
    const extra = (TEMPLATE.match(/<ExtraParams>([^<]*)<\/ExtraParams>/) || [])[1] || '';
    expect(extra).toMatch(/(^| )-p 172\.17\.0\.1:2210:2222( |$)/);
    expect(TEMPLATE).not.toMatch(/Target="2222"/);
  });
});
