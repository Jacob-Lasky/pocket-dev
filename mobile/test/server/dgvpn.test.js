import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Source-level guards for the dgvpn (Deepgram tailnet proxy) build wiring. Same
// rationale as entrypoint.test.js / tmuxConf.test.js: nothing in the cat-based
// E2E suite can exercise dgvpn (it needs a live tailnet), so the non-obvious,
// easy-to-silently-break invariants are asserted against the source instead.
describe('dgvpn build wiring', () => {
  const root = path.resolve(__dirname, '../../..');
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const dgvpnUp = fs.readFileSync(path.join(root, 'vpn/dgvpn-up'), 'utf8');
  const dgvpn = fs.readFileSync(path.join(root, 'vpn/dgvpn'), 'utf8');

  it('builds the proxy in a Go stage and copies it into the final image', () => {
    expect(dockerfile).toMatch(/FROM\s+golang:[\d.]+-\w+\s+AS\s+dgvpn-builder/);
    expect(dockerfile).toMatch(
      /COPY --from=dgvpn-builder \/dgvpn-proxy \/usr\/local\/bin\/dgvpn-proxy/,
    );
  });

  it('installs both wrapper scripts and makes all three executable', () => {
    expect(dockerfile).toMatch(/COPY vpn\/dgvpn vpn\/dgvpn-up \/usr\/local\/bin\//);
    expect(dockerfile).toMatch(
      /chmod \+x .*dgvpn .*dgvpn-up .*dgvpn-proxy/,
    );
  });

  it('sets the proxy port as a single runtime source of truth', () => {
    // The Go binary and both scripts read DGVPN_PROXY_PORT; pinning it here keeps
    // their in-code fallbacks from drifting. See the Dockerfile comment.
    expect(dockerfile).toMatch(/^ENV DGVPN_PROXY_PORT=\d+/m);
  });

  it('copies dgvpn AFTER the npm install layer (build-cache ordering)', () => {
    // dgvpn changes far more often than mobile/. If its COPY precedes the
    // expensive `npm install` (node-pty native build), every vpn-only edit busts
    // that layer. Keep the dgvpn COPY below npm install so the cache survives.
    const npmIdx = dockerfile.indexOf('npm install --production');
    const dgvpnCopyIdx = dockerfile.indexOf('COPY --from=dgvpn-builder');
    expect(npmIdx).toBeGreaterThanOrEqual(0);
    expect(dgvpnCopyIdx).toBeGreaterThanOrEqual(0);
    expect(dgvpnCopyIdx).toBeGreaterThan(npmIdx);
  });

  it('uses a consistent binary name across the Dockerfile and dgvpn-up', () => {
    // dgvpn-up identifies the live proxy by process name (pkill -x / /proc comm).
    // If the built binary name and these checks ever diverge, dgvpn-up silently
    // fails to find or restart the proxy. Assert they agree on "dgvpn-proxy".
    expect(dockerfile).toMatch(/go build -o \/dgvpn-proxy\b/);
    expect(dgvpnUp).toMatch(/nohup dgvpn-proxy\b/);
    expect(dgvpnUp).toMatch(/comm".*=.*"dgvpn-proxy"/);
  });

  it('dgvpn exports all three proxy env vars to the wrapped command', () => {
    // Libraries vary on which they honor; missing one silently leaks .consul
    // traffic around the tunnel. Guard the full set in both cases.
    for (const v of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
      expect(dgvpn).toContain(`${v}=`);
    }
  });
});
