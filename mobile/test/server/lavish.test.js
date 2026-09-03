import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnEnv } from './pdEnv.js';

// Source-level guards for the Lavish Editor wiring. Same rationale as
// codex.test.js / dgvpn.test.js / tmuxConf.test.js: nothing in the cat-based E2E
// suite can exercise Lavish (it needs a detached server, a published port, and a
// human with a browser), so the invariants that break SILENTLY are asserted
// against the Dockerfile, entrypoint.sh, the template and compose instead.
//
// The whole feature is one long chain (image install, port ENV, published port,
// bind address, Host allowlist) and every link fails quietly in its own way: a
// binary masked by the home mount, a loopback-only listener behind a published
// port, a wildcard bind that reads as "exposed" and behaves as loopback, a
// review URL carrying a 172.x address that resolves nowhere. None of them errors.
describe('Lavish Editor wiring', () => {
  const root = path.resolve(__dirname, '../../..');
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const entrypoint = fs.readFileSync(path.join(root, 'entrypoint.sh'), 'utf8');
  const template = fs.readFileSync(path.join(root, 'pocket-dev.xml'), 'utf8');
  const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');

  // The WHOLE RUN block, not just the line naming the package: a backslash
  // continuation is one shell command over several lines, so a per-line
  // assertion would be vacuous against `npm install -g \` followed by
  // `--prefix /home/claude/bin`. Same shape as codex.test.js.
  const installBlock = dockerfile.match(
    /^RUN npm install -g (?:.*\\\n)*.*\blavish-axi\b(?:.*\\\n)*.*$/m,
  );

  it('installs lavish-axi globally', () => {
    expect(installBlock).not.toBeNull();
  });

  it('installs into the image prefix, never into the home mount', () => {
    // /home/claude ships EMPTY and is a bind mount at runtime, so an image-owned
    // binary written under it is masked the moment the mount lands. ~/bin is
    // worse: it is EARLIER on PATH than /usr/local/bin, so a copy left there
    // would shadow the image's own on every future update, silently, forever.
    expect(installBlock[0]).not.toMatch(/--prefix|--location=?\s*user/);
    expect(installBlock[0]).not.toMatch(/\/home\/claude|\$\{?HOME\}?/);
    expect(dockerfile).not.toMatch(
      /(?:cp|mv|ln)\b[^\n]*\blavish-axi\b[^\n]*(?:\/home\/claude|\$\{?HOME\}?)/,
    );
  });

  it('takes the current release rather than a pinned version', () => {
    // Same call as codex, `claude` (install.sh) and `gh` (apt stable): every
    // build takes what is current. A pin freezes the tool at whatever was newest
    // the day the line was written and keeps working while it rots.
    expect(installBlock[0]).not.toMatch(/\blavish-axi@/);
  });

  it('records the resolved version in the build log', () => {
    // Unpinned means the Dockerfile cannot say what shipped, so the build has to.
    expect(installBlock[0]).toMatch(/lavish-axi --version/);
  });

  it('installs BEFORE the mobile/ copy (build-cache ordering)', () => {
    // Below `COPY mobile/`, every edit to the server would re-run the install;
    // above, it stays cached until the layers above it change.
    const lavishIdx = dockerfile.indexOf('lavish-axi');
    const copyIdx = dockerfile.indexOf('COPY mobile/');
    expect(lavishIdx).toBeGreaterThanOrEqual(0);
    expect(copyIdx).toBeGreaterThanOrEqual(0);
    expect(lavishIdx).toBeLessThan(copyIdx);
  });

  // Every place the port appears has to agree, so read it from the ENV and check
  // the rest against that rather than hard-coding 4387 four more times here.
  const envPort = (dockerfile.match(/^ENV LAVISH_AXI_PORT=(\d+)\s*$/m) || [])[1];

  it('pins the port once in the image, as the single source of truth', () => {
    expect(envPort).toBeTruthy();
  });

  it('EXPOSEs that same port', () => {
    // EXPOSE publishes nothing, it is documentation, but a stale number here is
    // documentation that lies about which port to map.
    expect(dockerfile).toMatch(new RegExp(`^EXPOSE ${envPort}$`, 'm'));
  });

  it('the template publishes that same port', () => {
    // Without a published port the review URL resolves only from inside the
    // container, which is the one place nobody is holding a browser.
    const config = template.match(/<Config Name="Lavish Editor Port"[^>]*>(\d+)<\/Config>/);
    expect(config).not.toBeNull();
    expect(config[1]).toBe(envPort);
    expect(config[0]).toMatch(new RegExp(`Target="${envPort}"`));
    expect(config[0]).toMatch(/Type="Port"/);
  });

  it('docker-compose publishes that same port', () => {
    // README calls compose a mirror of the UnRAID template, so a port in only one
    // of them makes that sentence false and makes a local run behave differently
    // from the deployed container with every other guard green.
    expect(compose).toMatch(new RegExp(`^\\s+- "${envPort}:${envPort}"$`, 'm'));
  });

  it('suppresses the browser launch, because there is no browser in here', () => {
    // Lavish catches the failed launch and downgrades "opened" to "ready", so this
    // is not load-bearing. It stops every open from shelling out to xdg-open,
    // waiting for it to fail, and reporting a status that misdescribes what happened.
    expect(dockerfile).toMatch(/^ENV LAVISH_AXI_NO_OPEN=1$/m);
  });

  it('does NOT set the bind address in the image', () => {
    // The address is assigned per container start and changes on every recreate,
    // so any value baked here is wrong by the second boot. entrypoint.sh resolves
    // it at runtime instead.
    expect(dockerfile).not.toMatch(/^ENV LAVISH_AXI_HOST=/m);
  });

  it('entrypoint sets the bind address before exec-ing the main command', () => {
    // The env has to be in place before server.js spawns any pty, because every
    // session's `lavish-axi` inherits it from there.
    const hostIdx = entrypoint.indexOf('export LAVISH_AXI_HOST=');
    const execIdx = entrypoint.search(/^\s*exec\s+"\$@"\s*$/m);
    expect(hostIdx).toBeGreaterThanOrEqual(0);
    expect(execIdx).toBeGreaterThanOrEqual(0);
    expect(hostIdx).toBeLessThan(execIdx);
  });

  it('the template exposes the link host and Host allowlist knobs', () => {
    // Reachability is only half the chain. Lavish 403s any request whose Host
    // header is not loopback, the bind address, or LAVISH_AXI_LINK_HOST, and with
    // no link host the URL it prints carries the container's 172.x bridge address,
    // which resolves nowhere outside the container. Both knobs have to be visible
    // in the template or that presents as "Lavish is broken".
    expect(template).toMatch(/<Config Name="LAVISH_AXI_LINK_HOST"[^>]*Target="LAVISH_AXI_LINK_HOST"/);
    expect(template).toMatch(
      /<Config Name="LAVISH_AXI_ALLOWED_HOSTS"[^>]*Target="LAVISH_AXI_ALLOWED_HOSTS"/,
    );
  });
});

// entrypoint.sh's bind-address resolution, RUN FOR REAL against a fake `hostname`.
//
// The guards above are textual, which is the right shape for a Dockerfile or an
// UnRAID template. This block is not: picking one address out of what `hostname -i`
// prints is BEHAVIOUR, and a test asserting the `case` arms appear in the file
// proves the string is there and nothing about which address comes out. Same
// reasoning as entrypointSeed.test.js versus homeMount.test.js.
//
// Every case here is a way the resolution can be silently wrong. Selecting a
// loopback or wildcard address is worse than selecting nothing, because Lavish
// accepts loopback and coerces the wildcard to it, so both boot a server that
// looks configured and is unreachable through the published port.
describe('entrypoint.sh bind-address resolution, executed', () => {
  const SCRIPT = path.resolve(__dirname, '../../../entrypoint.sh');
  let tmproot, home, skel, cache, bin;

  beforeEach(() => {
    tmproot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-lavish-'));
    home = path.join(tmproot, 'home');
    skel = path.join(tmproot, 'skel');
    cache = path.join(tmproot, 'cache');
    bin = path.join(tmproot, 'bin');
    fs.mkdirSync(home);
    fs.mkdirSync(skel);
    fs.mkdirSync(bin);
  });

  afterEach(() => {
    fs.rmSync(tmproot, { recursive: true, force: true });
  });

  // `hostname -i` is the only input to the resolution, so stub it and read back
  // what the script exported. The script execs its arguments, so the argument IS
  // the assertion surface: it prints the value the real server.js would inherit.
  function resolve(hostnameOutput, env = {}) {
    fs.writeFileSync(
      path.join(bin, 'hostname'),
      `#!/bin/sh
if [ "$1" = "-i" ]; then printf '%s\n' '${hostnameOutput}'; fi
`,
    );
    fs.chmodSync(path.join(bin, 'hostname'), 0o755);
    const res = spawnSync('bash', [SCRIPT, 'sh', '-c', 'printf "%s" "${LAVISH_AXI_HOST-UNSET}"'], {
      env: spawnEnv({
        HOME: home,
        PD_SKEL_DIR: skel,
        PD_CACHE_DIR: cache,
        PATH: `${bin}:${process.env.PATH}`,
        ...env,
      }),
      encoding: 'utf8',
    });
    expect(res.status, `entrypoint.sh exited ${res.status}: ${res.stderr}`).toBe(0);
    return { value: res.stdout, stderr: res.stderr };
  }

  it('exports the container address when there is one', () => {
    expect(resolve('172.17.0.29').value).toBe('172.17.0.29');
  });

  it('skips an IPv6 address and takes the IPv4', () => {
    // Docker's bridge publishes IPv4; binding the link-local IPv6 would leave the
    // published port pointing at nothing listening.
    expect(resolve('fe80::42:acff:fe11:1d 172.17.0.29').value).toBe('172.17.0.29');
  });

  it('leaves the bind address UNSET rather than selecting loopback', () => {
    // Lavish accepts 127.0.0.1 happily and serves on it, so selecting it produces a
    // running server that the published port cannot reach. Unset is the same
    // behaviour but it is Lavish's own documented default, and the script says so
    // on stderr, which is the only notice anyone gets.
    const { value, stderr } = resolve('127.0.0.1');
    expect(value).toBe('UNSET');
    expect(stderr).toMatch(/no non-loopback IPv4/);
  });

  it('leaves the bind address UNSET rather than selecting a wildcard', () => {
    // The wildcard is the one value that MUST never be selected: Lavish coerces it
    // back to loopback, so it reads as configured exposure and behaves as none.
    const { value, stderr } = resolve('0.0.0.0');
    expect(value).toBe('UNSET');
    expect(stderr).toMatch(/no non-loopback IPv4/);
  });

  it('rejects a token that is not an address at all', () => {
    // The positive `*.*.*.*` arm carries its own weight and this is the case that
    // proves it: the skip arm above only rejects loopback, the wildcard and
    // anything with a colon, so a non-address token reaches the selector. Caught by
    // mutation, widening the arm to `*` was invisible to every other case here
    // because the skip arm had already filtered them. It is shape triage, not
    // validation (`999.999.999.999` passes it, and Lavish then refuses to resolve
    // it and says so), but a hostname or an error string must not become a bind
    // address, because Lavish would fail to start on it.
    expect(resolve('localhost.localdomain-not-an-ip').value).toBe('UNSET');
  });

  it('survives hostname printing nothing, and still boots', () => {
    // `set -e` is on in this script, so an empty resolution must not be an error
    // exit: a container that will not start is a far worse outcome than one whose
    // Lavish is loopback-only. resolve() asserts status 0.
    expect(resolve('').value).toBe('UNSET');
  });

  it('never overwrites an explicit LAVISH_AXI_HOST', () => {
    // An operator pinning a specific interface in the template must not be
    // silently replaced by the guess on every boot.
    expect(resolve('172.17.0.29', { LAVISH_AXI_HOST: '10.1.2.3' }).value).toBe('10.1.2.3');
  });
});
