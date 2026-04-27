import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../server.js';

describe('express endpoints', () => {
  const app = createApp();

  it('GET /history returns 404 (endpoint removed)', async () => {
    const res = await request(app).get('/history');
    expect(res.status).toBe(404);
  });

  it('GET / returns the index.html', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('pocket-dev');
  });

  it('serves xterm.js static assets', async () => {
    const res = await request(app).get('/xterm/lib/xterm.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
  });
});
