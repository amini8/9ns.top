import { lstat, readdir, readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const siteRoot = fileURLToPath(new URL('../', import.meta.url));
export const repoRoot = resolve(siteRoot, '..');
export const outputRoot = resolve(siteRoot, 'dist');
export const publicFiles = Object.freeze([
  ['doc/index.html', 'index.html'],
  ['doc/pricing/index.html', 'pricing/index.html'],
  ['doc/404.html', '404.html'],
  ['doc/assets/site.css', 'assets/site.css'],
  ['doc/assets/dns-9ns.jpg', 'assets/dns-9ns.jpg'],
  ['doc/assets/batman.gif', 'assets/batman.gif'],
  ['doc/robots.txt', 'robots.txt'],
  ['doc/sitemap.xml', 'sitemap.xml'],
  ['doc/docs/index.html', 'docs/index.html'],
  ['src/resources/9ns-nodes.svg', 'assets/9ns-nodes.svg'],
]);

export async function rejectSymlinkPath(path, allowMissing = false) {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const part of relative(root, absolute).split(sep).filter(Boolean)) {
    current = join(current, part);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error('Symlink/junction is not allowed: ' + current);
  }
}

export async function listOutput(path = outputRoot, prefix = '') {
  await rejectSymlinkPath(path);
  if (!(await lstat(path)).isDirectory()) throw new Error('Expected output directory: ' + path);
  const files = [];
  for (const entry of (await readdir(path)).sort()) {
    const child = join(path, entry);
    const name = prefix + entry;
    const stat = await lstat(child);
    if (stat.isSymbolicLink()) throw new Error('Symlink/junction is not allowed: ' + child);
    if (stat.isDirectory()) files.push(...await listOutput(child, name + '/'));
    else if (stat.isFile()) files.push(name);
    else throw new Error('Non-regular output entry: ' + child);
  }
  return files;
}

export async function build() {
  if (dirname(outputRoot) !== resolve(siteRoot) || relative(siteRoot, outputRoot) !== 'dist'
      || relative(repoRoot, outputRoot) !== join('doc', 'dist')) {
    throw new Error('Refusing unsafe output target: ' + outputRoot);
  }
  await rejectSymlinkPath(outputRoot, true);
  const inputs = [];
  for (const [source, target] of publicFiles) {
    const path = resolve(repoRoot, source);
    await rejectSymlinkPath(path);
    if (!(await lstat(path)).isFile()) throw new Error('Expected regular input file: ' + source);
    inputs.push([target, await readFile(path)]);
  }
  try {
    await listOutput();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await rm(outputRoot, { recursive: true, force: true });
  for (const [target, bytes] of inputs) {
    const path = join(outputRoot, target);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
  console.log('Built ' + inputs.length + ' public files in ' + outputRoot);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await build();
}
