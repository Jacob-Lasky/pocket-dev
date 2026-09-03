import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnEnv } from './pdEnv.js';
import { buildTmuxSpawnArgs } from '../../server.js';

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
    //
    // `installBlock.index`, NOT `dockerfile.indexOf('lavish-axi')`. The first
    // textual mention is the COMMENT above the RUN, so an indexOf version stays
    // green when the install itself is moved below `COPY mobile/` and the comment
    // is left where it was. Verified: the first occurrence is a comment line.
    const copyIdx = dockerfile.indexOf('COPY mobile/');
    expect(copyIdx).toBeGreaterThanOrEqual(0);
    expect(installBlock.index).toBeLessThan(copyIdx);
  });

  // Every place the port appears has to agree, so read it from the ENV and check
  // the rest against that rather than hard-coding 4387 four more times here.
  const envPort = (dockerfile.match(/^ENV LAVISH_AXI_PORT=(\d+)\s*$/m) || [])[1];
  const webPort = (template.match(/<Config Name="WebUI Port" Target="(\d+)"/) || [])[1];

  it('pins the port once in the image, as the single source of truth', () => {
    // EXACTLY one, not at-least-one: a later `ENV LAVISH_AXI_PORT=` overrides an
    // earlier one silently, and every other check here reads the first match.
    const all = dockerfile.match(/^ENV LAVISH_AXI_PORT=\d+\s*$/gm) || [];
    expect(all).toHaveLength(1);
    expect(envPort).toBeTruthy();
  });

  it('is Lavish\u2019s own documented default port', () => {
    // An INDEPENDENT oracle, and the reason it is a literal rather than DRY-ed up
    // against envPort: every other port assertion in this file is derived from
    // this ENV, so changing the ENV moves both sides together and they all stay
    // green on a wrong value. 4387 is what lavish-axi binds with LAVISH_AXI_PORT
    // unset, so matching it keeps a session's bare `lavish-axi` and the published
    // mapping agreeing even where this variable does not reach.
    expect(envPort).toBe('4387');
  });

  it('EXPOSEs that same port', () => {
    // EXPOSE publishes nothing, it is documentation, but a stale number here is
    // documentation that lies about which port to map.
    expect(dockerfile).toMatch(new RegExp(`^EXPOSE ${envPort}$`, 'm'));
  });

  it('the template publishes that same port', () => {
    // Without a published port the review URL resolves only from inside the
    // container, which is the one place nobody is holding a browser. All four
    // attributes matter: UnRAID maps Default into a fresh install, the element
    // body into an existing one, and a missing Mode leaves the protocol unset.
    const config = template.match(/<Config Name="Lavish Editor Port"[^>]*>(\d+)<\/Config>/);
    expect(config).not.toBeNull();
    expect(config[1]).toBe(envPort);
    expect(config[0]).toMatch(new RegExp(`Target="${envPort}"`));
    expect(config[0]).toMatch(new RegExp(`Default="${envPort}"`));
    expect(config[0]).toMatch(/Mode="tcp"/);
    expect(config[0]).toMatch(/Type="Port"/);
  });

  it('the docs quote that same port', () => {
    // README, DEPLOYMENT-GUIDE and CLAUDE.md are three more copies of this number,
    // and they are what a human reads when the mapping does not work. Changing the
    // ENV, EXPOSE, template and compose together would otherwise leave the prose
    // behind with every other assertion here still green.
    //
    // Two filters, and BOTH were arrived at by a mutation getting through or a real
    // line getting flagged. SHAPE: only the three forms that unambiguously are a
    // port, because `(?:port |:)(4\d{3})` was case-sensitive and let "Port 4999"
    // past, while a blanket `\b\d{4}\b` flagged the year in "Tower 2026-09-03" and
    // the hex in the measured `/proc/net/tcp` value `410011AC:1123`. SCOPE: only
    // markdown sections that mention Lavish, because scanning whole files flagged
    // the dgvpn example's `...consul:9008/health`, which has nothing to do with this.
    const PORT_SHAPES = [/\bport\s+(\d{4})\b/gi, /\b(\d{4}):(\d{4})\b/g, /:(\d{4})\//g];
    for (const name of ['README.md', 'DEPLOYMENT-GUIDE.md', 'CLAUDE.md']) {
      const sections = fs
        .readFileSync(path.join(root, name), 'utf8')
        .split(/^(?=#{1,3} )/m)
        .filter((section) => /lavish/i.test(section));
      expect(sections.length, `${name} should document Lavish`).toBeGreaterThan(0);
      const found = new Set();
      for (const section of sections) {
        for (const shape of PORT_SHAPES) {
          for (const m of section.matchAll(shape)) for (const g of m.slice(1)) if (g) found.add(g);
        }
      }
      // The terminal port legitimately appears beside Lavish's, since half of what
      // the prose says is "publish this exactly where the terminal already is". Read
      // it from the template rather than writing a second literal to go stale.
      const wrong = [...found].filter((port) => port !== envPort && port !== webPort);
      expect(wrong, `${name} names a port that is neither ${envPort} nor ${webPort}`).toEqual([]);
      expect([...found], `${name} should name ${envPort}`).toContain(envPort);
    }
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
  let tmproot, home, skel, cache, bin, globdir;

  beforeEach(() => {
    tmproot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-lavish-'));
    home = path.join(tmproot, 'home');
    skel = path.join(tmproot, 'skel');
    cache = path.join(tmproot, 'cache');
    bin = path.join(tmproot, 'bin');
    globdir = path.join(tmproot, 'cwd');
    for (const d of [home, skel, bin, globdir]) fs.mkdirSync(d);
    // A filename that WOULD satisfy the script's IPv4 shape check if the address
    // list were ever glob-expanded against the working directory.
    fs.writeFileSync(path.join(globdir, '10.9.9.9'), 'bait\n');
  });

  afterEach(() => {
    fs.rmSync(tmproot, { recursive: true, force: true });
  });

  // `hostname -i` is the only input to the resolution, so stub it and read back
  // what the script exported. The script execs its arguments, so the argument IS
  // the assertion surface: it prints the value the real server.js would inherit.
  function resolve(hostnameOutput, env = {}) {
    const stub = path.join(bin, 'hostname');
    fs.writeFileSync(stub, ['#!/bin/sh', `[ "$1" = "-i" ] && printf '%s\\n' '${hostnameOutput}'`, ''].join('\n'));
    fs.chmodSync(stub, 0o755);
    // cwd is FIXED to a directory holding a file named like an IPv4 address, so the
    // pathname-expansion case below is deterministic rather than dependent on
    // whatever happens to sit in the repo when the suite runs.
    const res = spawnSync('bash', [SCRIPT, 'sh', '-c', 'printf "%s" "${LAVISH_AXI_HOST-UNSET}"'], {
      cwd: globdir,
      env: spawnEnv({
        HOME: home,
        PD_SKEL_DIR: skel,
        PD_CACHE_DIR: cache,
        // The script calls hostname by ABSOLUTE path so a writable ~/bin cannot
        // hijack the bind address, which means PATH is no longer a test seam.
        // PD_HOSTNAME_BIN is, and it is the only way this suite reaches the stub.
        PD_HOSTNAME_BIN: stub,
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

  it('does not glob the address list against the working directory', () => {
    // `for addr in $(hostname -i)` gets PATHNAME EXPANSION as well as word
    // splitting, so a `*` in that output is matched against the cwd and a filename
    // can be selected as the bind address. The cwd here contains a file named
    // 10.9.9.9, which satisfies the IPv4 shape arm exactly. The script uses
    // `read -ra`, which splits on IFS and never globs, so `*` stays literal, fails
    // the shape check, and the address is left unset.
    expect(resolve('*').value).toBe('UNSET');
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

  it('takes the first of several IPv4 addresses and SAYS which', () => {
    // A container on more than one network has several, and nothing inside it can
    // tell which one the published port forwards to, so the pick is a guess. The
    // failure it produces is a port that refuses connections, which reads as the
    // mapping being wrong rather than the bind being wrong. Naming the choice on
    // stderr is what makes that diagnosable, so the warning is the assertion.
    const { value, stderr } = resolve('172.18.0.4 172.17.0.29');
    expect(value).toBe('172.18.0.4');
    expect(stderr).toMatch(/several container IPv4 addresses/);
    expect(stderr).toContain('172.17.0.29');
  });

  it('does not warn about several addresses when there is only one', () => {
    // A warning on every ordinary boot is a warning nobody reads.
    expect(resolve('172.17.0.29').stderr).not.toMatch(/several container IPv4/);
  });

  it('rejects dotted tokens that are not four numbers', () => {
    // `*.*.*.*` as a glob pattern let all of these through. Lavish would refuse to
    // resolve them and say so, which is loud, but a hostname or an error string
    // has no business being handed to a listener in the first place.
    for (const bad of ['one.two.three.four', '10.0.0.1.invalid', '10.0.0', 'a.b.c.d']) {
      expect(resolve(bad).value, `${bad} must not be selected`).toBe('UNSET');
    }
  });

  it('does not let a writable ~/bin hijack the bind address', () => {
    // $PATH starts with $HOME/bin, which is inside the persistent home mount and
    // writable by the uid this runs as, so a bare `hostname` call would let any
    // leftover there choose the address (or hang the boot). The script calls an
    // absolute path, so a `hostname` planted on PATH is simply not consulted.
    fs.writeFileSync(path.join(bin, 'hostname'), '#!/bin/sh\nprintf "10.6.6.6\\n"\n');
    fs.chmodSync(path.join(bin, 'hostname'), 0o755);
    // resolve() rewrites the same file, so point the seam at a DIFFERENT stub and
    // check the PATH one loses.
    const honest = path.join(tmproot, 'honest-hostname');
    fs.writeFileSync(honest, '#!/bin/sh\nprintf "172.17.0.29\\n"\n');
    fs.chmodSync(honest, 0o755);
    const res = spawnSync('bash', [SCRIPT, 'sh', '-c', 'printf "%s" "${LAVISH_AXI_HOST-UNSET}"'], {
      cwd: globdir,
      env: spawnEnv({
        HOME: home,
        PD_SKEL_DIR: skel,
        PD_CACHE_DIR: cache,
        PD_HOSTNAME_BIN: honest,
        PATH: `${bin}:${process.env.PATH}`,
      }),
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('172.17.0.29');
  });

  it('never overwrites an explicit LAVISH_AXI_HOST', () => {
    // An operator pinning a specific interface in the template must not be
    // silently replaced by the guess on every boot.
    expect(resolve('172.17.0.29', { LAVISH_AXI_HOST: '10.1.2.3' }).value).toBe('10.1.2.3');
  });
});

// The link between "entrypoint.sh exported it" and "the session sees it".
//
// Live-verified 2026-09-03 on a container built from this branch: a session
// created through POST /sessions ran `lavish-axi` and its server bound
// 172.17.0.65:4387, the container's own address. That covers the case where node
// starts the tmux server. It does NOT cover a tmux server that was already
// running without the variable, which inherits nothing from node, and these
// assertions are what make that case impossible rather than unobserved.
describe('LAVISH_ forwarding into the tmux session environment', () => {
  it('forwards every LAVISH_ variable the server process holds', () => {
    const args = buildTmuxSpawnArgs('main-1', 'cmd', {
      envSource: { LAVISH_AXI_HOST: '172.17.0.9', LAVISH_AXI_PORT: '4387', HOME: '/home/claude' },
    });
    expect(args).toContain('-e');
    expect(args).toContain('LAVISH_AXI_HOST=172.17.0.9');
    expect(args).toContain('LAVISH_AXI_PORT=4387');
  });

  it('forwards by PREFIX, not by a list of names', () => {
    // A second runtime-resolved Lavish variable must not reintroduce the bug by
    // being forgotten, which is what a hard-coded list guarantees eventually.
    const args = buildTmuxSpawnArgs('main-1', 'cmd', {
      envSource: { LAVISH_SOMETHING_NEW: 'x' },
    });
    expect(args).toContain('LAVISH_SOMETHING_NEW=x');
  });

  it('carries nothing else from the process environment', () => {
    // Forwarding is a targeted fix for one prefix, not a general environment dump:
    // a session already inherits the pty env, and widening this would put every
    // secret in the server's environment on a tmux command line.
    const args = buildTmuxSpawnArgs('main-1', 'cmd', {
      envSource: { LAVISH_AXI_HOST: '172.17.0.9', ANTHROPIC_API_KEY: 'sk-secret' },
    });
    expect(args.join(' ')).not.toContain('sk-secret');
    expect(args.join(' ')).not.toContain('ANTHROPIC_API_KEY');
  });

  it('lets an explicit per-session env win over a forwarded one', () => {
    // The PD_* values are computed per session; the forwards are process-wide, so
    // a caller that has decided something must not be overwritten by the process.
    const args = buildTmuxSpawnArgs('main-1', 'cmd', {
      env: { LAVISH_AXI_HOST: '10.0.0.1' },
      envSource: { LAVISH_AXI_HOST: '172.17.0.9' },
    });
    expect(args).toContain('LAVISH_AXI_HOST=10.0.0.1');
    expect(args).not.toContain('LAVISH_AXI_HOST=172.17.0.9');
  });
});
