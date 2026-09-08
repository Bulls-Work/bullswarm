// Cross-process ownership and durable delegate identities for the V2 kernel.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid < 1) return null;
  try {
    const line = execFileSync('ps', ['-p', String(pid), '-o', 'stat=', '-o', 'lstart='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const match = /^(\S+)\s+(.+)$/.exec(line);
    return match && !match[1].startsWith('Z') ? match[2] : null;
  } catch { return null; }
}

export function acquireKernelLease(runDir) {
  const path = join(runDir, 'kernel.lock');
  const owner = { pid: process.pid, identity: processIdentity(process.pid), token: randomUUID() };
  for (let retry = 0; retry < 4; retry += 1) {
    let fd;
    try { fd = openSync(path, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let prior; let stat;
      try { stat = statSync(path); prior = JSON.parse(readFileSync(path, 'utf8')); }
      catch {
        // A kill during initialization can leave an empty lease. Give a live
        // synchronous writer a grace period, then allow recovery of that file.
        if (stat && Date.now() - stat.mtimeMs > 10_000) {
          try { if (statSync(path).ino === stat.ino) unlinkSync(path); } catch {}
          continue;
        }
        throw new Error(`run already has an active kernel lease being initialized; retry shortly: ${path}`);
      }
      if (processIdentity(prior.pid) === prior.identity && prior.identity) throw new Error(`run already has an active kernel (pid ${prior.pid})`);
      // Recheck inode and content immediately before reclaiming a dead owner.
      // Every subsequent kernel write is fenced by the unique owner token.
      try {
        if (statSync(path).ino === stat.ino && JSON.parse(readFileSync(path, 'utf8')).token === prior.token) unlinkSync(path);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      continue;
    }
    try { writeFileSync(fd, JSON.stringify(owner)); } finally { closeSync(fd); }
    const assertOwner = () => {
      if (!existsSync(path) || JSON.parse(readFileSync(path, 'utf8')).token !== owner.token) throw new Error('kernel lease lost; refusing further workflow writes or dispatch');
    };
    return { assertOwner, release() {
      try { assertOwner(); unlinkSync(path); } catch { /* Never remove another kernel's lease. */ }
    } };
  }
  throw new Error('could not claim kernel lease; another resume is starting');
}

export function liveWorker(worker) {
  const identity = processIdentity(worker.pid);
  if (identity !== null) return identity === worker.identity;
  if (!worker.processGroup) return false;
  // A delegate can exit before its grandchildren. A group with no living
  // leader still belongs to this recorded spawn, so drain it before replay.
  try {
    return execFileSync('ps', ['-axo', 'pgid=,stat='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').some((line) => { const [group, status] = line.trim().split(/\s+/); return Number(group) === worker.pid && status && !status.startsWith('Z'); });
  } catch { return false; }
}

export function stopWorker(worker, signal = 'SIGTERM') {
  if (!liveWorker(worker)) return;
  try { process.kill(worker.processGroup ? -worker.pid : worker.pid, signal); } catch { /* already gone */ }
}
