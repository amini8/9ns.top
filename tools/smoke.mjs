import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { siteRoot, outputRoot } from './build.mjs';

// Ask the OS for an unused loopback port; never reuse an existing dev server.
const reservation = createServer();
await new Promise((resolve, reject) => {
  reservation.once('error', reject);
  reservation.listen(0, '127.0.0.1', resolve);
});
const port = reservation.address().port;
await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
const origin = 'http://127.0.0.1:' + port;
const child = spawn(process.execPath, [
  join(siteRoot, 'node_modules/wrangler/bin/wrangler.js'),
  'dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', '0',
], {
  cwd: siteRoot,
  env: { ...process.env, WRANGLER_SEND_METRICS: 'false', BROWSER: 'none' },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: process.platform !== 'win32',
});
let logs = '';
let failure;
child.stdout.on('data', data => { logs = (logs + data).slice(-12000); });
child.stderr.on('data', data => { logs = (logs + data).slice(-12000); });
child.on('error', error => { failure = error; });
const exited = new Promise(resolve => child.once('exit', resolve));

async function request(path) {
  return fetch(origin + path, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
}

try {
  const deadline = Date.now() + 25000;
  let ready = false;
  while (Date.now() < deadline) {
    if (failure) throw failure;
    assert.equal(child.exitCode, null, 'Wrangler exited before becoming ready');
    try {
      const response = await request('/');
      if (response.status === 200) { ready = true; break; }
    } catch { /* A connection refusal is expected while the local server starts. */ }
    await delay(200);
  }
  assert.ok(ready, 'Local Wrangler did not start within 25 seconds');
  const pages = [
    ['/', 'index.html', 'text/html'],
    ['/pricing/', 'pricing/index.html', 'text/html'],
    ['/docs/', 'docs/index.html', 'text/html'],
    ['/assets/site.css', 'assets/site.css', 'text/css'],
    ['/assets/9ns-nodes.svg', 'assets/9ns-nodes.svg', 'image/svg+xml'],
    ['/assets/dns-9ns.jpg', 'assets/dns-9ns.jpg', 'image/jpeg'],
    ['/assets/batman.gif', 'assets/batman.gif', 'image/gif'],
    ['/robots.txt', 'robots.txt', 'text/plain'],
    ['/sitemap.xml', 'sitemap.xml', 'xml'],
  ];
  for (const [path, file, type] of pages) {
    const response = await request(path);
    assert.equal(response.status, 200, path);
    assert.ok(response.headers.get('content-type')?.includes(type), 'Content type: ' + path);
    assert.ok(Buffer.from(await response.arrayBuffer()).equals(await readFile(join(outputRoot, file))), 'Response bytes: ' + path);
  }
  for (const path of ['/pricing', '/docs', '/pricing/index.html', '/docs/index.html']) {
    const response = await request(path + '?from=check');
    assert.ok([301, 302, 307, 308].includes(response.status), 'Expected redirect: ' + path);
    const location = new URL(response.headers.get('location'), origin);
    assert.equal(location.origin, origin);
    assert.equal(location.pathname, path.startsWith('/pricing') ? '/pricing/' : '/docs/');
    assert.equal(location.search, '?from=check');
  }
  for (const path of ['/not-a-page', '/nested/missing', '/package.json', '/wrangler.jsonc', '/README.md', '/tools/build.mjs', '/.env', '/doc/docs/', '/doc/docs/index.html', '/doc/assets/site.css']) {
    const response = await request(path);
    assert.equal(response.status, 404, 'Must not expose a file or fall back to home: ' + path);
    assert.ok((await response.text()).includes('That page isn’t here.'), 'Custom 404: ' + path);
  }
  console.log('HTTP smoke checks passed: pages/assets, exact response bytes, slash redirects with queries, custom 404s, and private tooling isolation.');
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  // Stop only this child and its descendants, including the local workerd process.
  if (child.pid && child.exitCode === null) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 });
    } else {
      try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await Promise.race([exited, delay(5000)]);
  }
}
