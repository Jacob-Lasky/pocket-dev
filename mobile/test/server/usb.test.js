import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Source-level guards for host USB access and adb (#88). Same rationale as
// dgvpn.test.js and codex.test.js: CI has no phone and no host udev, so the
// pieces that break silently are asserted against the files that declare them.
// Each missing piece presents differently and none of them names its cause:
// no bind lists nothing, no cgroup rule is EPERM, no udev rule is "no
// permissions", and a bookworm adb has no `adb pair` at all.
describe('USB access for adb', () => {
  const root = path.resolve(__dirname, '../../..');
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const template = fs.readFileSync(path.join(root, 'pocket-dev.xml'), 'utf8');
  const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
  const udevRule = fs.readFileSync(path.join(root, 'host/99-pocket-dev-usb.rules'), 'utf8');
  const extraParams = (template.match(/<ExtraParams>([^<]*)<\/ExtraParams>/) || [])[1] || '';

  // The whole RUN block, since a backslash continuation spreads one command
  // over several lines and a per-line match would be vacuous.
  const adbBlock = dockerfile.match(/^RUN (?:.*\\\n)*.*\badb\b(?:.*\\\n)*.*$/m);

  it('installs adb from bookworm-backports, not stable bookworm', () => {
    // Stable bookworm ships adb 29.0.6, which has no `adb pair`, and wireless
    // pairing is the path that actually approved the key on #88.
    expect(adbBlock).not.toBeNull();
    expect(adbBlock[0]).toMatch(/-t bookworm-backports adb\b/);
    expect(adbBlock[0]).toMatch(/adb version/);
  });

  it('template opens usbfs through a cgroup rule, not a single --device node', () => {
    // A --device node is fixed at create time and a replug renumbers it.
    expect(extraParams).toMatch(/--device-cgroup-rule='c 189:\* rmw'/);
    expect(extraParams).not.toMatch(/--device[= ]\/dev\/bus\/usb/);
    expect(extraParams).not.toMatch(/--privileged(?!\S)/);
  });

  it('template binds the whole USB bus directory', () => {
    expect(template).toMatch(/Target="\/dev\/bus\/usb"[^>]*>\/dev\/bus\/usb<\/Config>/);
  });

  it('template keeps the pids ceiling that the live container depends on', () => {
    // It lived only on Tower's copy of the template for two months, so a
    // template-driven recreate from this file would have dropped it.
    expect(extraParams).toMatch(/--pids-limit 8192\b/);
  });

  it('docker-compose mirrors the template', () => {
    expect(compose).toMatch(/- \/dev\/bus\/usb:\/dev\/bus\/usb\r?$/m);
    expect(compose).toMatch(/device_cgroup_rules:\r?\n\s+- 'c 189:\* rmw'/);
    expect(compose).toMatch(/pids_limit:\s*8192\b/);
  });

  it('host udev rule hands usb_device nodes to gid 100, the container group', () => {
    const rule = udevRule.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
    expect(rule).toEqual([
      'SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_device", GROUP="users", MODE="0664"',
    ]);
  });
});
