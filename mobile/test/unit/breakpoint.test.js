// The desktop breakpoint exists twice in index.html and cannot be made to exist
// once: the CSS media query decides the layout, and JS decides the toolbar's
// first-run default (expanded on desktop, collapsed on a phone) by calling
// matchMedia. A media query cannot read a CSS custom property, so there is no
// single value both sides can share.
//
// What is available is a guard. If the two drift, the symptom is quiet and
// confusing rather than loud: a window between the two widths gets the desktop
// layout with the phone default, or the reverse, and the toolbar looks like it
// opened or collapsed for no reason. Same rationale as tmuxConf.test.js, which
// asserts on the source because the real thing cannot be exercised in a test.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const html = fs.readFileSync(path.resolve(__dirname, '../../public/index.html'), 'utf8');

describe('desktop breakpoint', () => {
  it('is declared once in JS and once in CSS, at the same width', () => {
    const js = html.match(/const DESKTOP_MIN_WIDTH\s*=\s*(\d+)\s*;/);
    expect(js, 'DESKTOP_MIN_WIDTH constant not found in index.html').not.toBeNull();

    const mediaWidths = [...html.matchAll(/@media\s*\(min-width:\s*(\d+)px\)/g)].map(m => m[1]);
    expect(mediaWidths, 'no min-width media query found').not.toHaveLength(0);

    // Every min-width breakpoint in the file should be the desktop one; a second
    // distinct value would mean a new tier that this guard does not know about.
    expect([...new Set(mediaWidths)]).toEqual([js[1]]);
  });

  it('drives the toolbar default from that constant, not a repeated literal', () => {
    // The matchMedia call has to interpolate the constant. Hardcoding the number
    // there would pass the width check above while still being a third copy.
    expect(html).toMatch(/matchMedia\(`\(min-width:\s*\$\{DESKTOP_MIN_WIDTH\}px\)`\)/);
  });
});
