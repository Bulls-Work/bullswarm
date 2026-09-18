// bullswarm update — bring the installed package to the latest published
// version, in place.
//
// Four install shapes, told apart by where THIS module really lives — the
// realpath of the running package — never by `which bullswarm` or
// `npm root -g`, both of which can point at a different Node install than the
// one that is running (nvm, Homebrew, a ~/.local prefix):
//   global      — <prefix>/lib/node_modules/bullswarm (posix) or
//                 <prefix>/node_modules/bullswarm (Windows). `npm install -g
//                 bullswarm@<latest> --prefix <prefix>` upgrades that exact copy.
//   pnpm-global — <home>/.pnpm/bullswarm@<version>/node_modules/bullswarm, linked
//                 from <home>/node_modules/bullswarm. That store path is NOT an
//                 install prefix: `npm install -g --prefix` against it writes
//                 into the OLD version's directory and never moves the link the
//                 shell resolves. pnpm owns this layout, so `pnpm add -g` does
//                 the upgrade and the LINK is what gets verified.
//   checkout    — the package root is a git working tree (a clone, or a global
//                 install that is an `npm link` into one). npm must not replace
//                 it: `git pull --ff-only` when the tree is clean, a refusal when
//                 it is not.
//   unknown     — anything else: the manual command is printed and the exit is 1.
//
// Same doctrine as the meters: numbers come from the source. The latest
// version is read from the npm registry, the installed version from the
// package.json on disk AFTER the install, and the two are compared — an npm
// exit 0 is not taken as proof that anything changed.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  basename, dirname, isAbsolute, join, relative, resolve, sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_NAME = 'bullswarm';
export const REGISTRY_LATEST_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const REGISTRY_TIMEOUT_MS = 8_000;
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const GIT_TIMEOUT_MS = 2 * 60_000;

function parseSemver(value) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(value ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Strict semver triples compared numerically (a pre-release or build suffix
 * is ignored): -1 when a < b, 0 when equal, 1 when a > b, null when either
 * side is not a version — an unknown is never reported as "up to date".
 */
export function compareVersions(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/**
 * How the running package is installed, from its root directory alone.
 *
 * @param {{packageRoot?: string, exists?: (p: string) => boolean}} [opts]
 * @returns {{kind: 'global'|'pnpm-global'|'checkout'|'unknown', root: string, prefix: string|null}}
 */
export function detectInstall({ packageRoot = PACKAGE_ROOT, exists = existsSync } = {}) {
  const root = packageRoot;
  // A working tree first: a global install that is an `npm link` into a
  // checkout has BOTH shapes, and replacing the link with a registry tarball
  // would silently detach the developer from their own repository.
  if (exists(join(root, '.git'))) return { kind: 'checkout', root, prefix: null };
  const parent = dirname(root);
  if (basename(parent) === 'node_modules') {
    // pnpm's virtual store, before the generic prefix rule: the layout is
    // <home>/.pnpm/<name>@<version>/node_modules/<name>, which satisfies that
    // rule and yields a per-version store directory as the "prefix".
    const store = dirname(dirname(parent));
    if (basename(store) === '.pnpm') {
      const home = dirname(store);
      // <project>/node_modules/.pnpm/... is a project dependency, not a global
      // install; upgrading it globally would touch a package nobody asked about.
      if (basename(home) === 'node_modules') return { kind: 'unknown', root, prefix: null };
      return { kind: 'pnpm-global', root, prefix: home };
    }
    const lib = dirname(parent);
    const prefix = basename(lib) === 'lib' ? dirname(lib) : lib;
    return { kind: 'global', root, prefix };
  }
  return { kind: 'unknown', root, prefix: null };
}

/**
 * The latest published version, from the registry's `latest` dist-tag.
 * Never throws: `{version: null, error}` says why nothing came back.
 */
export async function fetchLatestVersion({
  fetchImpl = globalThis.fetch, timeoutMs = REGISTRY_TIMEOUT_MS, url = REGISTRY_LATEST_URL,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!res.ok) return { version: null, error: `registry returned HTTP ${res.status}` };
    const data = await res.json();
    return typeof data?.version === 'string'
      ? { version: data.version, error: null }
      : { version: null, error: 'registry reply carried no version' };
  } catch (err) {
    const timedOut = err?.name === 'AbortError';
    return {
      version: null,
      error: timedOut ? `registry did not answer within ${timeoutMs / 1000}s` : (err?.message ?? String(err)),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** The version the package at `root` reports on disk right now, or null. */
export function readInstalledVersion(root, { read = readFileSync } = {}) {
  try {
    const version = JSON.parse(read(join(root, 'package.json'), 'utf8')).version;
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

function defaultExec(cmd, args, { timeout = 60_000 } = {}) {
  return execFileSync(cmd, args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout,
  });
}

function firstLine(err) {
  const text = String(err?.stderr || err?.message || err || '').trim();
  return text.split('\n').find((line) => line.trim()) ?? 'unknown error';
}

/** A directory with its symlinks resolved, or unchanged when it cannot be. */
function realDir(dir) {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

/**
 * Whether `target` is `dir` itself or sits beneath it — on path segments, not
 * on characters. A raw `startsWith` would read `/opt/pnpm-old/bullswarm` as
 * living under `/opt/pnpm`, and silently call a stale binary ours.
 */
function isInside(dir, target) {
  const rel = relative(realDir(dir), target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * One of pnpm's own global directories — `root` for its node_modules, `bin`
 * for its shims — or null when pnpm will not say. Asked rather than derived:
 * both are configurable (`global-dir`, `global-bin-dir`).
 */
function pnpmDir(exec, which) {
  try {
    const out = exec(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', [which, '-g'], { timeout: 10_000 });
    return String(out).trim().split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? null;
  } catch {
    return null;
  }
}

/** Where the shell's `bullswarm` really points, or null when it cannot tell. */
function shellBinaryTarget(exec) {
  try {
    const out = process.platform === 'win32'
      ? exec('where', [PACKAGE_NAME], { timeout: 5_000 })
      : exec('sh', ['-c', `command -v ${PACKAGE_NAME}`], { timeout: 5_000 });
    const path = String(out).trim().split('\n')[0];
    return path ? realpathSync(path) : null;
  } catch {
    return null;
  }
}

/**
 * `bullswarm update [--check] [--json]`. Returns the exit code: 0 when the
 * package is now (or already was) at the latest published version, or when
 * --check merely reported; 1 when the registry, npm or git refused, or when
 * the install shape is unknown.
 *
 * Every side effect is injectable so tests exercise each branch without a
 * network, an npm, or a git.
 */
export async function runUpdate({
  check = false,
  json = false,
  currentVersion = null,
  packageRoot = PACKAGE_ROOT,
  exec = defaultExec,
  fetchImpl = globalThis.fetch,
  exists = existsSync,
  readVersion = readInstalledVersion,
  log = console.log,
  warn = console.error,
  lookupShellBinary = true,
} = {}) {
  const install = detectInstall({ packageRoot, exists });
  const before = currentVersion ?? readVersion(install.root);
  const latest = await fetchLatestVersion({ fetchImpl });
  const result = {
    action: 'update',
    package: PACKAGE_NAME,
    install,
    // Where `after` was read from. install.root is where the RUNNING copy was
    // found, which pnpm leaves behind on its old per-version store directory,
    // so it cannot double as "where bullswarm lives now".
    verifiedAt: install.root,
    before,
    latest: latest.version,
    after: before,
    upToDate: null,
    updated: false,
    check,
    error: null,
    notes: [],
  };
  const say = (line) => { if (!json) log(line); };
  const finish = (code) => {
    if (json) log(JSON.stringify(result, null, 2));
    else if (result.error) warn(`update: ${result.error}`);
    else for (const note of result.notes) log(`  note: ${note}`);
    return code;
  };

  if (latest.version) {
    const cmp = compareVersions(before, latest.version);
    result.upToDate = cmp === null ? null : cmp >= 0;
  }

  if (check) {
    if (!latest.version) {
      result.error = `could not read the latest version from the npm registry: ${latest.error}`;
      return finish(1);
    }
    say(result.upToDate
      ? `${PACKAGE_NAME} ${before} is the latest published version`
      : `${PACKAGE_NAME} ${before} installed · ${latest.version} published · run: ${PACKAGE_NAME} update`);
    if (install.kind === 'checkout') result.notes.push(`source checkout at ${install.root}: update pulls git, not npm`);
    return finish(0);
  }

  if (install.kind === 'checkout') return updateCheckout(install, result, { exec, readVersion, say, finish });

  if (install.kind === 'unknown') {
    result.error = `cannot tell how ${PACKAGE_NAME} is installed at ${install.root}; run: npm install -g ${PACKAGE_NAME}@latest`;
    return finish(1);
  }

  if (!latest.version) {
    result.error = `could not read the latest version from the npm registry: ${latest.error}`;
    return finish(1);
  }
  if (result.upToDate) {
    say(`${PACKAGE_NAME} ${before} is already the latest published version (${install.root})`);
    return finish(0);
  }

  const pnpm = install.kind === 'pnpm-global';
  const exe = process.platform === 'win32' ? (pnpm ? 'pnpm.cmd' : 'npm.cmd') : (pnpm ? 'pnpm' : 'npm');
  const manager = pnpm ? 'pnpm' : 'npm';
  // Pinned to the version just read, not `@latest`, so the outcome below is
  // checkable against a number this process has already seen.
  const args = pnpm
    ? ['add', '-g', `${PACKAGE_NAME}@${latest.version}`]
    : [
      'install', '-g', `${PACKAGE_NAME}@${latest.version}`,
      '--prefix', install.prefix, '--no-fund', '--no-audit',
    ];
  say(`updating ${PACKAGE_NAME} ${before ?? '?'} → ${latest.version} at ${install.root}`);
  say(`  ${exe} ${args.join(' ')}`);
  try {
    exec(exe, args, { timeout: INSTALL_TIMEOUT_MS });
  } catch (err) {
    result.error = `${manager} ${args[0]} failed: ${firstLine(err)}`;
    return finish(1);
  }

  // pnpm gives each version its own store directory, so install.root still
  // holds the OLD copy afterwards. The link under the global node_modules is
  // the one the shell resolves, so that is what proves the upgrade landed —
  // and pnpm is asked where that directory is NOW, rather than trusting the
  // path the pre-upgrade copy happened to be found at.
  const verifyRoot = pnpm
    ? join(pnpmDir(exec, 'root') ?? join(install.prefix, 'node_modules'), PACKAGE_NAME)
    : install.root;
  result.verifiedAt = verifyRoot;
  const after = readVersion(verifyRoot);
  result.after = after;
  if (after !== latest.version) {
    result.error = `${manager} exited 0 but ${join(verifyRoot, 'package.json')} now reads ${after ?? 'nothing'}, not ${latest.version}`;
    return finish(1);
  }
  result.updated = true;
  say(`updated ${PACKAGE_NAME} ${before ?? '?'} → ${after}`);
  if (lookupShellBinary) {
    const target = shellBinaryTarget(exec);
    // pnpm's shim is a shell script in its own global bin directory, outside
    // the per-version store, so install.root — the OLD version's directory —
    // proves nothing here. Ask pnpm where that directory is; when it will not
    // say, warn about nothing rather than tell someone to delete a live shim.
    const owned = pnpm
      ? (() => { const bin = pnpmDir(exec, 'bin'); return bin ? [bin, install.prefix] : null; })()
      : [install.root];
    // isInside resolves each directory the same way shellBinaryTarget resolves
    // its answer: a home or prefix behind a symlink (/var → /private/var on
    // macOS) would otherwise never match the very path it points at.
    if (target && owned && !owned.some((dir) => isInside(dir, target))) {
      result.notes.push(
        `your shell's ${PACKAGE_NAME} resolves to ${target}, not the copy just updated — `
        + `see \`which -a ${PACKAGE_NAME}\` and remove the stale one`,
      );
    }
  }
  result.notes.push(`this process is still ${before ?? 'the old version'}; the next ${PACKAGE_NAME} command runs ${after}`);
  return finish(0);
}

function updateCheckout(install, result, { exec, readVersion, say, finish }) {
  const git = (args, timeout = GIT_TIMEOUT_MS) => String(exec('git', ['-C', install.root, ...args], { timeout }));
  let status;
  try {
    status = git(['status', '--porcelain'], 30_000);
  } catch (err) {
    result.error = `git status failed in ${install.root}: ${firstLine(err)}`;
    return finish(1);
  }
  if (status.trim()) {
    result.error = `source checkout at ${install.root} has local changes; commit or stash them, then run: git -C ${install.root} pull --ff-only`;
    return finish(1);
  }
  say(`source checkout at ${install.root}: git pull --ff-only`);
  try {
    git(['pull', '--ff-only']);
  } catch (err) {
    result.error = `git pull --ff-only failed in ${install.root}: ${firstLine(err)}`;
    return finish(1);
  }
  const after = readVersion(install.root);
  result.after = after;
  result.updated = after != null && after !== result.before;
  say(result.updated
    ? `pulled ${install.root}: ${result.before ?? '?'} → ${after}`
    : `source checkout at ${install.root} is already current (${after ?? '?'})`);
  if (result.latest && compareVersions(after, result.latest) === -1) {
    result.notes.push(`npm has ${result.latest}; this checkout follows git, not the registry`);
  } else if (!result.latest) {
    result.notes.push(`npm registry not reachable (${result.error ?? 'no version read'}); the checkout was pulled anyway`);
  }
  return finish(0);
}
