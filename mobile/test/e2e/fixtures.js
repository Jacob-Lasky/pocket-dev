import { test as base, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import path from 'node:path';
import net from 'node:net';

async function pickPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

export const test = base.extend({
  pdServer: async ({}, use) => {
    const port = await pickPort();
    const proc = spawn('node', [path.resolve(__dirname, '../../server.js')], {
      env: {
        ...process.env,
        PORT: String(port),
        // Deterministic stand-in for Claude — `cat` echoes our typed input back into the buffer.
        SHELL_CMD: 'cat',
        TMUX_SESSION: `pdtest-${port}`,
      },
      stdio: 'pipe',
    });

    // Wait for server to log its listen line
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server did not start within 5s')), 5000);
      proc.stdout.on('data', chunk => {
        if (chunk.toString().includes('pocket-dev on')) {
          clearTimeout(timeout);
          resolve();
        }
      });
      proc.on('exit', code => reject(new Error(`Server exited early with code ${code}`)));
    });

    await use({ port, baseURL: `http://localhost:${port}` });

    proc.kill('SIGTERM');
    await new Promise(resolve => proc.on('exit', resolve));
  },
});

export { expect };
