import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listOutput, outputRoot, publicFiles, rejectSymlinkPath, repoRoot } from './build.mjs';

const origin = 'https://9ns.top';
const releases = 'https://github.com/amini8/9ns/releases';
const expected = publicFiles.map(([, target]) => target).sort();
assert.deepEqual((await listOutput()).sort(), expected, 'Public output must match the allowlist exactly');

const contents = new Map();
for (const [source, target] of publicFiles) {
  const sourcePath = join(repoRoot, source);
  await rejectSymlinkPath(sourcePath);
  const bytes = await readFile(join(outputRoot, target));
  assert.ok(bytes.equals(await readFile(sourcePath)), 'Output differs from authoritative source: ' + target);
  contents.set(target, bytes.toString('utf8'));
}

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (entity, name) => {
    if (name[0] === '#') {
      return String.fromCodePoint(name[1].toLowerCase() === 'x'
        ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10));
    }
    return { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' }[name.toLowerCase()];
  });
}

function markup(text) {
  return text.replace(/<!--[\s\S]*?-->/g, '');
}

function attributes(tag) {
  const attrs = new Map();
  for (const match of tag.matchAll(/([:\w-]+)\s*=\s*(["'])(.*?)\2/gs)) {
    attrs.set(match[1].toLowerCase(), decodeEntities(match[3]));
  }
  return attrs;
}

function plainText(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

const ids = new Map();
for (const [file, text] of contents) {
  if (!/\.(html|svg)$/.test(file)) continue;
  const found = new Set();
  for (const tag of markup(text).matchAll(/<[a-z][^>]*>/gi)) {
    const id = attributes(tag[0]).get('id');
    if (id !== undefined) {
      assert.ok(!found.has(id), 'Duplicate id in ' + file + ': ' + id);
      found.add(id);
    }
  }
  ids.set(file, found);
}

function pageUrl(file) {
  return new URL('/' + file.replace(/(^|\/)index\.html$/, '$1'), origin);
}

function checkReference(value, file) {
  assert.ok(value.trim(), 'Empty reference in ' + file);
  assert.ok(!/^javascript:/i.test(value), 'JavaScript URL in ' + file);
  const url = new URL(value, pageUrl(file));
  if (url.hostname === '9ns.top') assert.equal(url.origin, origin, 'Production links must use HTTPS without a custom port');
  if (url.origin !== origin) return;
  assert.equal(url.protocol, 'https:', 'Internal URLs must use HTTPS');
  const path = decodeURIComponent(url.pathname).slice(1);
  const target = expected.includes(path) ? path : (path && !path.endsWith('/') ? path + '/' : path) + 'index.html';
  assert.ok(contents.has(target), 'Missing internal target from ' + file + ': ' + value);
  if (url.hash) {
    const fragment = decodeURIComponent(url.hash.slice(1));
    assert.ok(ids.get(target)?.has(fragment), 'Missing fragment from ' + file + ': ' + value);
  }
}

function checkCss(text, file) {
  for (const match of text.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) {
    checkReference(match[2].trim(), file);
  }
  for (const match of text.matchAll(/@import\s+(["'])(.*?)\1/gi)) checkReference(match[2], file);
}

for (const [file, text] of contents) {
  if (file.endsWith('.css')) checkCss(text, file);
  if (!/\.(html|svg)$/.test(file)) continue;
  const html = markup(text);
  assert.ok(!/<script\b/i.test(html), 'Static pages must not include JavaScript: ' + file);
  for (const match of html.matchAll(/<[a-z][^>]*>/gi)) {
    const attrs = attributes(match[0]);
    assert.ok(!/^<base\b/i.test(match[0]), 'Base URLs are not supported: ' + file);
    for (const [name, value] of attrs) {
      assert.ok(!/^on/i.test(name), 'Inline event handler in ' + file);
      if (['href', 'xlink:href', 'src', 'poster', 'action'].includes(name)) checkReference(value, file);
      if (/url\(/i.test(value)) checkCss(value, file);
    }
  }
  for (const style of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) checkCss(style[1], file);
  for (const anchor of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = attributes(anchor[1]);
    const href = attrs.get('href');
    const label = plainText(anchor[2]) + ' ' + (attrs.get('aria-label') ?? '') + ' ' + (attrs.get('title') ?? '');
    assert.ok(href, 'Anchor without href in ' + file);
    if (/\b(download\w*|releases?)\b/i.test(label) || /\/releases(?:[/?#]|$)/i.test(href)
        || attrs.has('download') || /\.(exe|msi|zip)(?:[?#]|$)/i.test(href)) {
      assert.equal(href, releases, 'Download/release destination in ' + file);
    }
  }
}

for (const [file, canonical] of [['index.html', origin + '/'], ['pricing/index.html', origin + '/pricing/'], ['docs/index.html', origin + '/docs/']]) {
  const html = markup(contents.get(file));
  const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((match) => attributes(match[0]));
  const canonicals = links.filter((attrs) => attrs.get('rel')?.toLowerCase().split(/\s+/).includes('canonical'));
  assert.equal(canonicals.length, 1, 'Exactly one canonical required in ' + file);
  assert.equal(canonicals[0].get('href'), canonical, 'Production canonical in ' + file);
  assert.ok(!/yogadns/i.test(html), 'Foreign branding in ' + file);
}
for (const id of ['main', 'features']) {
  assert.ok(ids.get('index.html').has(id), 'Homepage anchor required: ' + id);
}
assert.ok(!ids.get('index.html').has('protocols'), 'Removed protocol strip must not return');
assert.ok([...markup(contents.get('index.html')).matchAll(/<img\b[^>]*>/gi)]
  .some(match => attributes(match[0]).get('src') === '/assets/dns-9ns.jpg'),
  'Homepage must display the application preview');

assert.ok(publicFiles.some(([source, target]) => source === 'doc/docs/index.html' && target === 'docs/index.html'),
  'Documentation must build from doc/docs/ and remain at /docs/');
const docs = markup(contents.get('docs/index.html'));
const docsTags = [...docs.matchAll(/<[a-z][^>]*>/gi)].map((match) => ({ tag: match[0], attrs: attributes(match[0]) }));
assert.equal(docsTags.filter(({ tag }) => /^<main\b/i.test(tag)).length, 1, 'Documentation requires one main landmark');
for (const [tagName, className] of [['header', 'site-header'], ['footer', 'site-footer']]) {
  assert.ok(docsTags.some(({ tag, attrs }) => new RegExp('^<' + tagName + '\\b', 'i').test(tag)
    && attrs.get('class')?.split(/\s+/).includes(className)), 'Documentation requires shared ' + tagName);
}
assert.ok(docsTags.some(({ tag, attrs }) => /^<link\b/i.test(tag)
  && attrs.get('rel') === 'stylesheet' && attrs.get('href') === '/assets/site.css'), 'Documentation requires shared stylesheet');
assert.ok(docsTags.some(({ tag, attrs }) => /^<a\b/i.test(tag)
  && attrs.get('class')?.split(/\s+/).includes('skip-link') && attrs.get('href') === '#main'), 'Documentation requires skip link');
assert.ok(docsTags.some(({ tag, attrs }) => /^<a\b/i.test(tag)
  && attrs.get('href') === '/docs/' && attrs.get('aria-current') === 'page'), 'Documentation navigation must mark current page');
for (const id of ['main', 'use-cases', 'prevent-dns-leak', 'dnssec-made-easy', 'dns-and-multiple-interfaces',
  'introduction', 'installation', 'quick-start', 'main-window', 'dns-servers', 'rules', 'pools-and-relays',
  'dns-servers-import', 'configuration-files-and-logs', 'windows-service-mode', 'kernel-driver', 'building-from-source']) {
  assert.ok(ids.get('docs/index.html').has(id), 'Documentation anchor required: ' + id);
}

const pricing = markup(contents.get('pricing/index.html'));
const mains = [...pricing.matchAll(/<main\b[^>]*>([\s\S]*?)<\/main>/gi)];
assert.equal(mains.length, 1, 'Pricing requires one main landmark');
const pricingLinks = [...mains[0][1].matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)];
assert.equal(pricingLinks.length, 1, 'Pricing main requires only one release link');
assert.equal(attributes(pricingLinks[0][1]).get('href'), releases);
assert.ok(plainText(pricingLinks[0][2]), 'Pricing release link needs visible text');
assert.equal(plainText(mains[0][1].replace(pricingLinks[0][0], '')), 'Free, Opensource', 'Pricing main wording');

const notFound = [...contents.get('404.html').matchAll(/<meta\b[^>]*>/gi)].map((match) => attributes(match[0]));
assert.ok(notFound.some((attrs) => attrs.get('name')?.toLowerCase() === 'robots'
  && attrs.get('content')?.toLowerCase().split(/[\s,]+/).includes('noindex')), '404 must be noindex');

const sitemap = contents.get('sitemap.xml');
const locations = [...sitemap.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)].map((match) => decodeEntities(match[1].trim()));
assert.deepEqual(locations.sort(), [origin + '/', origin + '/docs/', origin + '/pricing/'].sort(), 'Production sitemap URLs');
for (const url of locations) checkReference(url, 'sitemap.xml');
const robots = contents.get('robots.txt');
const sitemapLines = [...robots.matchAll(/^Sitemap:\s*(\S+)\s*$/gim)].map((match) => match[1]);
assert.deepEqual(sitemapLines, [origin + '/sitemap.xml'], 'Production robots sitemap');
assert.ok(/^User-agent:\s*\*\s*$/im.test(robots), 'Robots must address all crawlers');
for (const url of robots.matchAll(/https?:\/\/[^\s]+/g)) {
  assert.equal(new URL(url[0]).origin, origin, 'Robots URLs must use the production domain');
}

console.log('Website checks passed: exact allowlist, source bytes, links/fragments, pricing, canonicals, sitemap and robots.');
