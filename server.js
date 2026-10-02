#!/usr/bin/env node
/**
 * Screen Studio — local recording server.
 * Zero-dependency Node server: serves the recorder + editor UI, streams
 * recording uploads to disk, and shells out to ffmpeg / faster-whisper
 * for composite, transcription, and clean-video renders.
 *
 *   node server.js            → http://localhost:4321
 */
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const { pipeline } = require('stream');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const RECORDINGS = path.join(ROOT, 'recordings');
const SCRIPTS = path.join(ROOT, 'scripts');
const PYTHON = [
  path.join(ROOT, '.venv', 'bin', 'python3'),          // macOS / Linux venv
  path.join(ROOT, '.venv', 'Scripts', 'python.exe'),   // Windows venv
].find(fs.existsSync) || 'python3';                    // fall back to PATH
const PORT = process.env.PORT || 4321;
// Local-only by default: binding 0.0.0.0 would let anyone on the network
// upload files, delete renders, and start ffmpeg jobs on this machine.
const HOST = process.env.HOST || '127.0.0.1';

fs.mkdirSync(RECORDINGS, { recursive: true });

// ---------- Google Drive archive (rclone) ----------
// Old recordings are moved to Drive and their media deleted locally; the small
// edit sidecars stay so the session is still listed and restorable in one click.
const ARCHIVE_CONFIG = path.join(ROOT, 'archive-config.json');
const ARCHIVE_DEFAULTS = {
  enabled: false,              // opt-in: nothing leaves this machine until it's on
  olderThanDays: 1,            // auto-sweep cutoff for whole recordings
  rendersOlderThanDays: 7,     // manual "archive old renders" cutoff, Renders page
  remote: 'gdrive:Local Editor Archive',
  keepLocal: false,            // true = back up only, don't reclaim the space
};
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;

function archiveConfig() {
  try { return { ...ARCHIVE_DEFAULTS, ...JSON.parse(fs.readFileSync(ARCHIVE_CONFIG, 'utf8')) }; }
  catch { return { ...ARCHIVE_DEFAULTS }; }
}

const MEDIA_EXT = /\.(webm|mp4|mov|mkv|wav|mp3|m4a|aac)$/i;

// Which finished outputs the Renders page shows. reframe-* are intermediates.
function renderKind(f) {
  return f.endsWith('-music.mp4') ? 'music'
    : /^clean(-[\w-]+)?\.mp4$/.test(f) ? 'clean'
    : f === 'composite.mp4' ? 'composite'
    : /^asset-[\w-]+\.(mp4|webm)$/.test(f) ? 'asset' : null;
}

// The archive map is per-file, so a session can be partly archived (one render
// pushed to Drive from the Renders page). Tolerates the {name: size} shape the
// first version of archive.py wrote.
function archivedMap(meta) {
  const files = (meta.archive || {}).files || {};
  const out = {};
  for (const [n, v] of Object.entries(files)) out[n] = (v && typeof v === 'object') ? v : { size: v };
  return out;
}

// A session is sweepable when every one of its media files has been sitting
// untouched for longer than the cutoff — editing or re-rendering anything
// resets the clock for the whole session.
async function sessionArchiveInfo(id) {
  const dir = path.join(RECORDINGS, id);
  let meta = {};
  try { meta = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8')); } catch {}
  const archived = archivedMap(meta);
  const archivedBytes = Object.values(archived).reduce((s, v) => s + (v.size || 0), 0);
  const names = (await fsp.readdir(dir).catch(() => []))
    .filter(n => MEDIA_EXT.test(n) && !n.startsWith('.'));
  let bytes = 0, newestMtime = 0;
  for (const n of names) {
    const st = await fsp.stat(path.join(dir, n)).catch(() => null);
    if (!st) continue;
    bytes += st.size;
    newestMtime = Math.max(newestMtime, st.mtimeMs);
  }
  return {
    archived: Object.keys(archived).length > 0 && names.length === 0, // fully offline
    archivedFiles: archived, archivedBytes,
    remote: (meta.archive || {}).remote || null,
    bytes, newestMtime, mediaCount: names.length,
  };
}

// Media another session pulls inserts from must stay on disk, or the borrowing
// edit loses its footage. Returns Map<session id, Set of file names in use> —
// file-level because the Renders page archives individual files, and one
// borrowed asset clip has to survive even when the rest of its folder is stale.
async function insertSourceFiles() {
  const used = new Map();
  const entries = await fsp.readdir(RECORDINGS, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    let trs;
    try { trs = JSON.parse(await fsp.readFile(path.join(RECORDINGS, e.name, 'transcript.json'), 'utf8')); }
    catch { continue; }
    for (const ins of trs.inserts || []) {
      if (!ins.fromSession || ins.fromSession === e.name) continue;
      if (!used.has(ins.fromSession)) used.set(ins.fromSession, new Set());
      used.get(ins.fromSession).add(ins.fromFile || 'composite.mp4');   // render.py's default
    }
  }
  return used;
}

// Protected session ids, for the calls that move or delete a whole recording.
async function insertSourceSessions() {
  return new Set((await insertSourceFiles()).keys());
}

async function archiveCandidates(cfg) {
  const cutoff = Date.now() - Math.max(0, cfg.olderThanDays) * 86400000;
  const guarded = await insertSourceSessions();
  const out = [];
  const entries = await fsp.readdir(RECORDINGS, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const info = await sessionArchiveInfo(e.name);
    if (!info.mediaCount) continue;              // nothing left on disk to move
    if (info.newestMtime > cutoff) continue;
    if (guarded.has(e.name)) continue;
    if (jobs[e.name] && jobs[e.name].status === 'running') continue;
    out.push({ id: e.name, bytes: info.bytes, files: info.mediaCount, mtime: info.newestMtime });
  }
  out.sort((a, b) => a.mtime - b.mtime);   // oldest first
  return out;
}

// `files` (optional) restricts the job to those names — the Renders page
// archives/restores one finished video at a time.
function startArchiveJob(id, action, cfg, files) {
  const args = [path.join(SCRIPTS, 'archive.py'), action, path.join(RECORDINGS, id),
                '--remote', cfg.remote];
  if (files && files.length) args.push('--files', ...files);
  if (action === 'archive' && cfg.keepLocal) args.push('--keep');
  return runJob(id, action === 'archive' ? 'archive' : 'restore', PYTHON, args);
}

// "clean.mp4" — a plain media file name, never a path
function safeMediaNames(param) {
  if (!param) return null;
  const names = param.split(',').map(s => s.trim()).filter(Boolean);
  if (!names.length) return null;
  if (!names.every(n => safeName(n) && MEDIA_EXT.test(n))) throw new Error('bad file name');
  return names;
}

// Media facts straight from ffmpeg, for the things a browser cannot tell us.
function probeMedia(file) {
  return new Promise(resolve => {
    const child = spawn('ffprobe', ['-v', 'quiet', '-print_format', 'json',
                                    '-show_format', '-show_streams', file]);
    let out = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.on('close', () => {
      let info = null;
      try { info = JSON.parse(out); } catch {}
      if (!info) return resolve(null);
      const v = (info.streams || []).find(st => st.codec_type === 'video');
      const pix = (v && v.pix_fmt) || '';
      const tags = Object.fromEntries(Object.entries((v && v.tags) || {})
        .map(([k, val]) => [k.toLowerCase(), val]));
      resolve({
        duration: parseFloat((info.format || {}).duration) || 0,
        // VP9 hides alpha behind a tag rather than the pixel format
        alpha: /^(yuva|rgba|argb|bgra|gbrap)/.test(pix) || tags.alpha_mode === '1',
        codec: (v && v.codec_name) || null,
      });
    });
    child.on('error', () => resolve(null));
  });
}

// Delete one file from the remote. Used when a render that lives on Drive is
// deleted from the Renders page — a missing remote copy is not an error here,
// the point is that it ends up gone.
function rcloneDeleteFile(remotePath) {
  return rcloneRemove(['deletefile', remotePath], remotePath);
}

// Whole remote folder, for deleting an archived recording outright.
function rclonePurge(remotePath) {
  return rcloneRemove(['purge', remotePath], remotePath);
}

function rcloneRemove(args, remotePath) {
  return new Promise(resolve => {
    const child = spawn('rclone', args, { cwd: ROOT });
    let err = '';
    child.stderr.on('data', d => { err += d.toString(); });
    child.on('close', code => {
      if (code !== 0) console.error(`[archive] rclone ${args[0]} ${remotePath}: ${err.trim()}`);
      resolve(code === 0);
    });
    child.on('error', e => { console.error(`[archive] rclone ${args[0]}:`, e.message); resolve(false); });
  });
}

// Background sweep: archive eligible sessions one at a time, never in parallel
// (Drive commits are safest single-threaded, and it keeps the upload readable).
let sweeping = false;
async function sweepArchive() {
  const cfg = archiveConfig();
  if (!cfg.enabled || sweeping) return { swept: 0, skipped: true };
  sweeping = true;
  let swept = 0;
  try {
    for (const c of await archiveCandidates(cfg)) {
      if (!archiveConfig().enabled) break;         // toggled off mid-sweep
      console.log(`[archive] ${c.id} → Drive (${(c.bytes / 1e9).toFixed(2)} GB)`);
      let job;
      try { job = startArchiveJob(c.id, 'archive', cfg); } catch { continue; }
      await new Promise(resolve => {
        const t = setInterval(() => {
          if (jobs[c.id] !== job || job.status !== 'running') { clearInterval(t); resolve(); }
        }, 2000);
      });
      if (job.status === 'done') swept++;
      else console.log(`[archive] ${c.id} failed (${job.status}) — media left on disk`);
    }
  } finally { sweeping = false; }
  return { swept };
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webm': 'video/webm', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.srt': 'text/plain', '.txt': 'text/plain',
  '.png': 'image/png', '.svg': 'image/svg+xml',
};

// One job at a time per session, with live log capture the UI can poll.
const jobs = {}; // sessionId -> { name, status, log, code }

// Path-safe name: word chars, dots, dashes — but never dots-only ("..", ".")
// which would escape the directory via path.join.
function safeName(s) {
  return !!s && /^[\w.-]+$/.test(s) && !/^\.+$/.test(s);
}

function safeSession(id) {
  if (!safeName(id)) throw new Error('bad session id');
  return id;
}

function sessionDir(id) { return path.join(RECORDINGS, safeSession(id)); }

function json(res, code, obj) {
  if (res.headersSent) return res.destroy();
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(body);
}

// One writer at a time per file, and every write lands by rename. Two
// overlapping plain writeFile calls interleave their chunks into invalid JSON
// (a 1MB transcript is written in 512KB pieces), and a reader that arrives
// mid-write sees half a file. Read-modify-write callers run the whole cycle
// inside the lock so a concurrent save can't slip in between.
const fileLocks = new Map();
function withFileLock(file, fn) {
  const run = (fileLocks.get(file) || Promise.resolve()).then(fn);
  const settled = run.then(() => {}, () => {});
  fileLocks.set(file, settled);
  settled.then(() => { if (fileLocks.get(file) === settled) fileLocks.delete(file); });
  return run;
}

async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}

// Stream a file to the response. pipeline() — not .pipe() — so a client that
// aborts mid-transfer (every <video> seek does) also closes the file; .pipe()
// left one descriptor open per aborted request, and those held deleted media
// on disk until the server restarted.
function sendFile(res, filePath, opts) {
  pipeline(fs.createReadStream(filePath, opts), res, () => {});
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function runJob(sessionId, name, cmd, args, onDone) {
  if (jobs[sessionId] && jobs[sessionId].status === 'running') {
    throw new Error(`job "${jobs[sessionId].name}" already running for ${sessionId}`);
  }
  const job = { name, status: 'running', log: '', code: null, cancelled: false };
  jobs[sessionId] = job;
  // detached -> own process group, so cancelling kills ffmpeg/whisper children too
  const child = spawn(cmd, args, { cwd: ROOT, detached: true });
  job.child = child;
  const capture = d => {
    const s = d.toString();
    // scripts announce phases with "»stage <name>" so the UI can label the bar
    const st = [...s.matchAll(/»stage (\w+)/g)].pop();
    if (st) job.stage = st[1];
    job.log += s;
    if (job.log.length > 200000) job.log = job.log.slice(-150000);
  };
  child.stdout.setEncoding('utf8');      // "»" is 2 bytes and can straddle chunks
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.on('close', code => {
    job.code = code;
    job.status = code === 0 ? 'done' : job.cancelled ? 'cancelled' : 'error';
    if (onDone) onDone(code);
  });
  child.on('error', err => {
    job.log += `\nspawn error: ${err.message}`;
    job.status = 'error';
    job.code = -1;
  });
  return job;
}

async function listSessions() {
  const out = [];
  const entries = await fsp.readdir(RECORDINGS, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(RECORDINGS, e.name);
    const files = await fsp.readdir(dir).catch(() => []);
    let meta = {};
    try { meta = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8')); } catch {}
    const archived = archivedMap(meta);
    const archivedNames = Object.keys(archived);
    // on-disk media weight, so the delete confirm can say what's actually lost
    let bytes = 0;
    for (const n of files) {
      if (!MEDIA_EXT.test(n) || n.startsWith('.')) continue;
      const st = await fsp.stat(path.join(dir, n)).catch(() => null);
      if (st) bytes += st.size;
    }
    out.push({
      id: e.name,
      files,
      bytes,
      createdAt: meta.createdAt || null,
      title: meta.title || e.name,
      renderNames: meta.renderNames || {},
      compressed: meta.compressed || {},
      // archive: null when nothing is on Drive; `whole` distinguishes a fully
      // offline recording from one with a single render archived
      archive: archivedNames.length ? {
        remote: (meta.archive || {}).remote || null,
        count: archivedNames.length,
        bytes: Object.values(archived).reduce((s, v) => s + (v.size || 0), 0),
        at: archived[archivedNames[0]].at || null,
        whole: !files.some(n => MEDIA_EXT.test(n) && !n.startsWith('.')),
      } : null,
      hasComposite: files.includes('composite.mp4'),
      hasTranscript: files.includes('transcript.json'),
      hasClean: files.includes('clean.mp4'),
      hasRaw: files.includes('screen.webm') || files.includes('webcam.webm'),
      job: jobs[e.name] ? { name: jobs[e.name].name, status: jobs[e.name].status } : null,
    });
  }
  out.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return out;
}

function serveStatic(res, filePath, range) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    // app files must never be cached — with no headers Chrome caches
    // heuristically and a plain refresh can keep running week-old JS
    if (['.html', '.js', '.css', '.json'].includes(ext)) {
      res.setHeader('Cache-Control', 'no-store');
    }
    // Range support so <video> seeking works.
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m && (m[1] || m[2])) {
        const suffix = !m[1];                       // "bytes=-N": the last N bytes
        const start = suffix ? Math.max(0, stat.size - parseInt(m[2], 10)) : parseInt(m[1], 10);
        const end = suffix || !m[2] ? stat.size - 1 : Math.min(parseInt(m[2], 10), stat.size - 1);
        if (start > end || start >= stat.size) {
          res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
          return res.end();
        }
        res.writeHead(206, {
          'Content-Type': type,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
        });
        return sendFile(res, filePath, { start, end });
      }
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
    sendFile(res, filePath);
  });
}

// DNS-rebinding and cross-site guard. Bound to loopback, the only legitimate
// Host is this machine's own name; any other means a hostile page resolved its
// domain to 127.0.0.1 and is calling the API with full access. And a browser
// sends Origin on every POST/DELETE — one from another site is refused, so a
// page you happen to have open can't start jobs or overwrite recordings.
const LOOPBACK = ['127.0.0.1', 'localhost', '::1'].includes(HOST);
const LOCAL_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);
function allowedRequest(req) {
  const host = (req.headers.host || '').toLowerCase();
  if (LOOPBACK && !LOCAL_HOSTS.has(host)) return false;
  const origin = req.headers.origin;
  if (origin && req.method !== 'GET' && req.method !== 'HEAD') {
    try { return new URL(origin).host.toLowerCase() === host; } catch { return false; }
  }
  return true;
}

process.on('unhandledRejection', err => console.error('[unhandled]', err && err.stack || err));

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, `http://localhost:${PORT}`); }
  catch { res.writeHead(400); return res.end('bad request'); }
  const p = url.pathname;
  if (!allowedRequest(req)) { res.writeHead(403); return res.end('forbidden'); }
  try {
    // ---------- API ----------
    if (p === '/api/sessions' && req.method === 'GET') {
      return json(res, 200, await listSessions());
    }

    if (p === '/api/upload' && req.method === 'POST') {
      const id = safeSession(url.searchParams.get('session'));
      const name = url.searchParams.get('name');
      if (!safeName(name)) return json(res, 400, { error: 'bad file name' });
      const dir = sessionDir(id);
      await fsp.mkdir(dir, { recursive: true });
      // an aborted upload must not leave a truncated screen.webm under its
      // real name — write beside it and rename once the body is complete
      const dest = path.join(dir, name);
      const part = `${dest}.part`;
      pipeline(req, fs.createWriteStream(part), async err => {
        try {
          if (err) throw err;
          await fsp.rename(part, dest);
          json(res, 200, { ok: true, saved: `${id}/${name}` });
        } catch (e) {
          await fsp.unlink(part).catch(() => {});
          json(res, 500, { error: e.message });
        }
      });
      return;
    }

    // A clip the browser cannot decode (ProRes, DNxHD, …) uploads fine and
    // renders fine — ffmpeg reads it — but <video> reports no duration, so the
    // clip used to land on the timeline zero seconds long and silently play
    // nothing. Probe it properly, and build a preview copy the browser can show.
    if (p === '/api/insert-prepare' && req.method === 'POST') {
      const id = safeSession(url.searchParams.get('session'));
      const names = safeMediaNames(url.searchParams.get('file'));
      if (!names || names.length !== 1) return json(res, 400, { error: 'bad file name' });
      const file = names[0];
      const src = path.join(sessionDir(id), file);
      if (!fs.existsSync(src)) return json(res, 404, { error: 'no such file' });
      const info = await probeMedia(src);
      if (!info || !info.duration) return json(res, 422, { error: `ffmpeg could not read ${file}` });
      const proxy = `proxy-${file.replace(/\.[^.]+$/, '')}.${info.alpha ? 'webm' : 'mp4'}`;
      let started = true;
      // the duration alone already makes the clip work; the preview is a bonus,
      // so a busy session is not an error here
      try { runJob(id, 'proxy', PYTHON, [path.join(SCRIPTS, 'proxy.py'), sessionDir(id), '--insert', file]); }
      catch { started = false; }
      return json(res, 200, { ok: true, duration: info.duration, alpha: info.alpha,
                              codec: info.codec, proxy, started });
    }

    if (p === '/api/transcript' && req.method === 'GET') {
      const id = safeSession(url.searchParams.get('session'));
      const file = path.join(sessionDir(id), 'transcript.json');
      if (!fs.existsSync(file)) return json(res, 404, { error: 'no transcript yet' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return sendFile(res, file);
    }

    if (p === '/api/transcript' && req.method === 'POST') {
      const id = safeSession(url.searchParams.get('session'));
      const body = await readBody(req);
      const incoming = JSON.parse(body.toString()); // validate before writing
      // Stale-tab guard: if the transcript was regenerated since this editor
      // tab loaded it, refuse the save instead of clobbering the new version.
      const file = path.join(sessionDir(id), 'transcript.json');
      const stale = await withFileLock(file, async () => {
        let disk = null;
        try { disk = JSON.parse(await fsp.readFile(file, 'utf8')); } catch {}
        if (disk && disk.generatedAt && incoming.generatedAt !== disk.generatedAt) return true;
        await writeAtomic(file, body);
        return false;
      });
      if (stale) {
        return json(res, 409, { error: 'transcript was regenerated — reload the editor to get the new version (your cuts were migrated into it)' });
      }
      return json(res, 200, { ok: true });
    }

    if (p === '/api/job' && req.method === 'GET') {
      const id = safeSession(url.searchParams.get('session'));
      const job = jobs[id];
      return json(res, 200, job ? { name: job.name, status: job.status, code: job.code, stage: job.stage || null, tail: job.log.slice(-4000) } : { status: 'idle' });
    }

    if (p === '/api/job/cancel' && req.method === 'POST') {
      const id = safeSession(url.searchParams.get('session'));
      const job = jobs[id];
      if (!job || job.status !== 'running') return json(res, 200, { ok: false, status: job ? job.status : 'idle' });
      job.cancelled = true;
      job.log += '\n— cancelled by user —\n';
      try { process.kill(-job.child.pid, 'SIGTERM'); }        // whole process group
      catch { try { job.child.kill('SIGTERM'); } catch {} }
      return json(res, 200, { ok: true });
    }

    if (p === '/api/composite' && req.method === 'POST') {
      const id = safeSession(url.searchParams.get('session'));
      runJob(id, 'composite', PYTHON, [path.join(SCRIPTS, 'composite.py'), sessionDir(id)]);
      return json(res, 200, { ok: true, started: 'composite' });
    }

    // after a recording: transcription and the composite run side by side
    if (p === '/api/process' && req.method === 'POST') {
      const id = safeSession(url.searchParams.get('session'));
      const model = url.searchParams.get('model') || 'small';
      if (!/^(tiny|base|small|medium|large-v[23](-turbo)?|distil-[\w.-]+)$/.test(model)) {
        return json(res, 400, { error: 'bad model name' });
      }
      runJob(id, 'process', PYTHON, [path.join(SCRIPTS, 'process.py'), sessionDir(id), '--model', model]);
      return json(res, 200, { ok: true, started: 'process' });
    }

    if (p === '/api/transcribe' && req.method === 'POST') {
      const id = safeSession(url.searchParams.get('session'));
      const model = url.searchParams.get('model') || 'small';
      if (!/^(tiny|base|small|medium|large-v[23](-turbo)?|distil-[\w.-]+)$/.test(model)) {
        return json(res, 400, { error: 'bad model name' });
      }
      runJob(id, 'transcribe', PYTHON, [path.join(SCRIPTS, 'transcribe.py'), sessionDir(id), '--model', model]);
      return json(res, 200, { ok: true, started: 'transcribe' });
    }

    if (p === '/api/enhance' && req.method === 'POST') {
      const id = safeSession(url.searchParams.get('session'));
      runJob(id, 'enhance', PYTHON, [path.join(SCRIPTS, 'enhance.py'), sessionDir(id)]);
      return json(res, 200, { ok: true, started: 'enhance' });
    }

    if (p === '/api/register-insert' && req.method === 'POST') {
      // attach a separately-recorded session as an insert in another session
      const id = safeSession(url.searchParams.get('session'));
      const from = safeSession(url.searchParams.get('from'));
      const at = parseFloat(url.searchParams.get('at') || '0') || 0;
      const duration = parseFloat(url.searchParams.get('duration') || '0') || 0;
      const file = path.join(sessionDir(id), 'transcript.json');
      const count = await withFileLock(file, async () => {
        let trs = { words: [], settings: { padSec: 0.12, maxGapSec: 1.0 } };
        try { trs = JSON.parse(await fsp.readFile(file, 'utf8')); } catch {}
        trs.inserts = trs.inserts || [];
        trs.inserts.push({
          id: `ins-${Date.now().toString(36)}`, at, fromSession: from,
          kind: 'video', duration, label: `recorded insert (${from})`,
        });
        await writeAtomic(file, JSON.stringify(trs, null, 2));
        return trs.inserts.length;
      });
      return json(res, 200, { ok: true, inserts: count });
    }

    if (p === '/api/meta' && req.method === 'POST') {
      const id = safeSession(url.searchParams.get('session'));
      const patch = JSON.parse((await readBody(req)).toString());
      const file = path.join(sessionDir(id), 'meta.json');
      const meta = await withFileLock(file, async () => {
        let m = {};
        try { m = JSON.parse(await fsp.readFile(file, 'utf8')); } catch {}
        if (typeof patch.title === 'string' && patch.title.trim()) m.title = patch.title.trim();
        if (patch.renderNames && typeof patch.renderNames === 'object') {
          m.renderNames = { ...(m.renderNames || {}), ...patch.renderNames };
        }
        await writeAtomic(file, JSON.stringify(m, null, 2));
        return m;
      });
      return json(res, 200, { ok: true, title: meta.title, renderNames: meta.renderNames });
    }

    if (p === '/api/renders' && req.method === 'GET') {
      const out = [];
      const entries = await fsp.readdir(RECORDINGS, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const dir = path.join(RECORDINGS, e.name);
        const files = await fsp.readdir(dir).catch(() => []);
        const credits = files.includes('credits.txt')
          ? await fsp.readFile(path.join(dir, 'credits.txt'), 'utf8').catch(() => null) : null;
        let meta = {};
        try { meta = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8')); } catch {}
        const archived = archivedMap(meta);
        // renders that moved to Drive are listed too — they're gone from disk
        // but still belong on this page, as a card offering to fetch them back
        for (const f of new Set([...files, ...Object.keys(archived)])) {
          const kind = renderKind(f);
          if (!kind) continue;
          const arch = archived[f];
          const st = arch ? null : await fsp.stat(path.join(dir, f)).catch(() => null);
          if (!arch && (!st || !st.size)) continue;
          out.push({ session: e.name, file: f, kind,
                     size: arch ? (arch.size || 0) : st.size,
                     mtime: arch ? Date.parse(arch.at || '') || 0 : st.mtimeMs,
                     archived: !!arch,
                     title: meta.title || e.name,
                     label: (meta.renderNames || {})[f] || null,
                     credits: kind === 'music' ? credits : null });
        }
      }
      out.sort((a, b) => b.mtime - a.mtime);
      return json(res, 200, out);
    }

    if (p === '/api/music' && req.method === 'GET') {
      const libFile = path.join(ROOT, 'music', 'library.json');
      if (!fs.existsSync(libFile)) return json(res, 200, {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return sendFile(res, libFile);
    }

    if (p === '/api/addmusic' && req.method === 'POST') {
      const id = safeSession(url.searchParams.get('session'));
      const track = url.searchParams.get('track');
      if (!safeName(track)) return json(res, 400, { error: 'bad track name' });
      const gain = String(parseFloat(url.searchParams.get('gain') || '-21') || -21);
      const args = [path.join(SCRIPTS, 'addmusic.py'), sessionDir(id), '--track', track, '--gain', gain];
      const input = url.searchParams.get('input');
      if (input) {
        if (!/^(clean(-[\w-]+)?|composite)\.mp4$/.test(input)) return json(res, 400, { error: 'bad input file' });
        args.push('--input', input);
      }
      runJob(id, 'addmusic', PYTHON, args);
      return json(res, 200, { ok: true, started: 'addmusic' });
    }

    if (p === '/api/render' && req.method === 'POST') {
      const id = safeSession(url.searchParams.get('session'));
      const quality = url.searchParams.get('quality') || 'balanced';
      const format = url.searchParams.get('format') || 'wide';
      const layout = url.searchParams.get('layout') || 'cam-top';
      if (!/^(high|balanced|small)$/.test(quality) || !/^(wide|short|square)$/.test(format)
          || !/^(cam-top|cam-bottom|overlay)$/.test(layout)) {
        return json(res, 400, { error: 'bad render options' });
      }
      const renderArgs = [path.join(SCRIPTS, 'render.py'), sessionDir(id),
        '--quality', quality, '--format', format, '--layout', layout];
      if (url.searchParams.get('compress') === '1') renderArgs.push('--compress');
      if (url.searchParams.get('denoise') === '1') renderArgs.push('--denoise');
      const rstart = parseFloat(url.searchParams.get('rstart'));
      const rend = parseFloat(url.searchParams.get('rend'));
      if (isFinite(rstart) && isFinite(rend) && rend > rstart) {
        renderArgs.push('--range', String(rstart), String(rend));
      }
      runJob(id, 'render', PYTHON, renderArgs);
      return json(res, 200, { ok: true, started: 'render' });
    }

    if (p === '/api/files' && req.method === 'GET') {
      const id = safeSession(url.searchParams.get('session'));
      const dir = sessionDir(id);
      let meta = {};
      try { meta = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8')); } catch {}
      const compressed = meta.compressed || {};
      const names = (await fsp.readdir(dir).catch(() => []))
        .filter(n => /\.(webm|mp4|mov)$/i.test(n) && !n.startsWith('asset-') && !n.startsWith('.'))
        .sort();
      const files = [];
      for (const n of names) {
        let size = 0;
        try { size = (await fsp.stat(path.join(dir, n))).size; } catch {}
        files.push({ name: n, size, compressed: compressed[n] || null });
      }
      return json(res, 200, { files, total: files.reduce((s, f) => s + f.size, 0) });
    }

    if (p === '/api/compress-files' && req.method === 'POST') {
      const id = safeSession(url.searchParams.get('session'));
      runJob(id, 'compress-files', PYTHON, [path.join(SCRIPTS, 'compress.py'), sessionDir(id)]);
      return json(res, 200, { ok: true, started: 'compress-files' });
    }

    if (p === '/api/proxy' && req.method === 'POST') {
      const id = safeSession(url.searchParams.get('session'));
      runJob(id, 'proxy', PYTHON, [path.join(SCRIPTS, 'proxy.py'), sessionDir(id)]);
      return json(res, 200, { ok: true, started: 'proxy' });
    }

    if (p === '/api/subsession' && req.method === 'POST') {
      const id = safeSession(url.searchParams.get('session'));
      const start = parseFloat(url.searchParams.get('start'));
      const end = parseFloat(url.searchParams.get('end'));
      if (!isFinite(start) || !isFinite(end) || end <= start) {
        return json(res, 400, { error: 'bad range' });
      }
      runJob(id, 'subsession', PYTHON, [path.join(SCRIPTS, 'subsession.py'),
        sessionDir(id), '--start', String(start), '--end', String(end)]);
      return json(res, 200, { ok: true, started: 'subsession' });
    }

    // ---------- Google Drive archive ----------
    if (p === '/api/archive/status' && req.method === 'GET') {
      const cfg = archiveConfig();
      const candidates = await archiveCandidates(cfg);
      let archived = 0, archivedBytes = 0, archivedFiles = 0;
      const entries = await fsp.readdir(RECORDINGS, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const info = await sessionArchiveInfo(e.name);
        const n = Object.keys(info.archivedFiles).length;
        if (!n) continue;
        archivedFiles += n;
        archivedBytes += info.archivedBytes;
        if (info.archived) archived++;      // fully offline, vs a stray render
      }
      return json(res, 200, {
        config: cfg, sweeping,
        candidates: candidates.map(c => ({ ...c })),
        pendingBytes: candidates.reduce((s, c) => s + c.bytes, 0),
        archived, archivedBytes, archivedFiles,
      });
    }

    if (p === '/api/archive/config' && req.method === 'POST') {
      const patch = JSON.parse((await readBody(req)).toString());
      const cfg = archiveConfig();
      if (typeof patch.enabled === 'boolean') cfg.enabled = patch.enabled;
      if (typeof patch.keepLocal === 'boolean') cfg.keepLocal = patch.keepLocal;
      const days = parseFloat(patch.olderThanDays);
      if (isFinite(days) && days >= 0) cfg.olderThanDays = days;
      const rdays = parseFloat(patch.rendersOlderThanDays);
      if (isFinite(rdays) && rdays >= 0) cfg.rendersOlderThanDays = rdays;
      if (typeof patch.remote === 'string' && /^[\w.-]+:[^\0]*$/.test(patch.remote.trim())) {
        cfg.remote = patch.remote.trim();
      }
      await withFileLock(ARCHIVE_CONFIG, () => writeAtomic(ARCHIVE_CONFIG, JSON.stringify(cfg, null, 2)));
      return json(res, 200, { ok: true, config: cfg });
    }

    if (p === '/api/archive' && req.method === 'POST') {
      const id = safeSession(url.searchParams.get('session'));
      const cfg = archiveConfig();
      // an explicit button press is a backup+reclaim even when the sweep is off
      if (url.searchParams.get('keep') === '1') cfg.keepLocal = true;
      const files = safeMediaNames(url.searchParams.get('files'));
      // footage another edit plays stays put unless the press says otherwise
      const inUse = (await insertSourceFiles()).get(id);
      if (inUse && !cfg.keepLocal && url.searchParams.get('force') !== '1') {
        const clash = files ? files.filter(f => inUse.has(f)) : [...inUse];
        if (clash.length) {
          return json(res, 409, {
            error: `cannot archive ${clash.join(', ')} — another recording plays it as a timeline insert, `
                 + 'and moving it to Drive would leave that edit with missing footage',
            needsForce: true, files: clash,
          });
        }
      }
      startArchiveJob(id, 'archive', cfg, files);
      return json(res, 200, { ok: true, started: 'archive' });
    }

    if (p === '/api/archive/restore' && req.method === 'POST') {
      const id = safeSession(url.searchParams.get('session'));
      startArchiveJob(id, 'restore', archiveConfig(), safeMediaNames(url.searchParams.get('files')));
      return json(res, 200, { ok: true, started: 'restore' });
    }

    // Finished renders older than `days`, grouped by session — the Renders page
    // bulk-archive. Grouped because only one job runs per session at a time, so
    // two eligible renders in one recording must go in a single rclone pass.
    if (p === '/api/archive/renders' && req.method === 'GET') {
      const cfg = archiveConfig();
      const d = parseFloat(url.searchParams.get('days'));
      const days = isFinite(d) && d >= 0 ? d : cfg.rendersOlderThanDays;
      const cutoff = Date.now() - days * 86400000;
      const groups = [];
      const borrowed = await insertSourceFiles();
      let held = 0;
      const entries = await fsp.readdir(RECORDINGS, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (jobs[e.name] && jobs[e.name].status === 'running') continue;
        const dir = path.join(RECORDINGS, e.name);
        let meta = {};
        try { meta = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8')); } catch {}
        const archived = archivedMap(meta);
        const inUse = borrowed.get(e.name) || new Set();
        const picked = [];
        let bytes = 0, oldest = Infinity;
        for (const f of await fsp.readdir(dir).catch(() => [])) {
          if (!renderKind(f) || archived[f]) continue;         // already on Drive
          if (inUse.has(f)) { held++; continue; }              // another edit plays it
          const st = await fsp.stat(path.join(dir, f)).catch(() => null);
          if (!st || !st.size || st.mtimeMs > cutoff) continue;
          picked.push(f); bytes += st.size; oldest = Math.min(oldest, st.mtimeMs);
        }
        if (picked.length) {
          groups.push({ session: e.name, title: meta.title || e.name,
                        files: picked.sort(), bytes, mtime: oldest });
        }
      }
      groups.sort((a, b) => a.mtime - b.mtime);                // oldest first
      return json(res, 200, {
        days, groups, held,
        files: groups.reduce((s, g) => s + g.files.length, 0),
        bytes: groups.reduce((s, g) => s + g.bytes, 0),
      });
    }

    if (p === '/api/archive/sweep' && req.method === 'GET') {
      // the UI drives the sweep itself (one session at a time) so it can show
      // per-file progress; this just hands it the eligible list. The list
      // ignores the enabled flag — pressing the button is its own consent.
      return json(res, 200, { candidates: await archiveCandidates(archiveConfig()) });
    }

    // Delete a whole recording: the session folder and, if it was archived,
    // its Drive copy. Irreversible, so it refuses in the two cases where the
    // user almost certainly doesn't mean it.
    if (p === '/api/session' && req.method === 'DELETE') {
      const id = safeSession(url.searchParams.get('session'));
      const dir = sessionDir(id);
      if (!fs.existsSync(dir)) return json(res, 404, { error: 'no such recording' });
      if (jobs[id] && jobs[id].status === 'running') {
        return json(res, 409, { error: `"${jobs[id].name}" is still running for this recording — cancel it first` });
      }
      // another recording's timeline plays footage from this one
      const guarded = await insertSourceSessions();
      if (guarded.has(id) && url.searchParams.get('force') !== '1') {
        return json(res, 409, {
          error: 'another recording uses this one as a timeline insert — deleting it would leave that edit with missing footage',
          needsForce: true,
        });
      }
      let meta = {};
      try { meta = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8')); } catch {}
      const remote = (meta.archive || {}).remote;
      let drive = null;
      if (remote && Object.keys(archivedMap(meta)).length) drive = await rclonePurge(remote);
      await fsp.rm(dir, { recursive: true, force: true });
      delete jobs[id];
      return json(res, 200, { ok: true, deleted: id, drivePurged: drive });
    }

    if (p === '/api/render' && req.method === 'DELETE') {
      const id = safeSession(url.searchParams.get('session'));
      const file = url.searchParams.get('file') || '';
      // only finished render outputs may be deleted — never the raw recordings
      const deletable = /^(clean(-[\w-]+)?\.mp4|[\w-]+-music\.mp4|composite\.mp4|reframe-[\w-]+\.mp4|asset-[\w-]+\.(mp4|webm|mov))$/;
      if (!deletable.test(file)) return json(res, 400, { error: 'not a deletable render file' });
      const dir = sessionDir(id);
      const metaFile = path.join(dir, 'meta.json');
      let meta = {};
      try { meta = JSON.parse(await fsp.readFile(metaFile, 'utf8')); } catch {}
      // An archived render has no local copy — delete the Drive copy instead,
      // otherwise the card never goes away and the upload is orphaned.
      if (archivedMap(meta)[file]) {
        const remote = (meta.archive || {}).remote;
        if (remote) await rcloneDeleteFile(`${remote}/${file}`);
        const files = { ...archivedMap(meta) };
        delete files[file];
        if (Object.keys(files).length) meta.archive = { remote, files };
        else delete meta.archive;
        await withFileLock(metaFile, () => writeAtomic(metaFile, JSON.stringify(meta, null, 2)));
        return json(res, 200, { ok: true, deleted: `${remote}/${file}`, fromDrive: true });
      }
      await fsp.unlink(path.join(dir, file)).catch(err => { throw err; });
      return json(res, 200, { ok: true, deleted: `${id}/${file}` });
    }

    // ---------- static ----------
    if (p.startsWith('/music/')) {
      const rel = decodeURIComponent(p.slice('/music/'.length));
      if (!safeName(rel)) { res.writeHead(400); return res.end(); }
      return serveStatic(res, path.join(ROOT, 'music', rel), req.headers.range);
    }
    if (p.startsWith('/recordings/')) {
      const rel = decodeURIComponent(p.slice('/recordings/'.length));
      if (rel.includes('..')) { res.writeHead(400); return res.end(); }
      return serveStatic(res, path.join(RECORDINGS, rel), req.headers.range);
    }
    let rel = p === '/' ? 'index.html' : decodeURIComponent(p.slice(1));
    if (rel.includes('..')) { res.writeHead(400); return res.end(); }
    return serveStatic(res, path.join(PUBLIC, rel), req.headers.range);
  } catch (err) {
    return json(res, 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Local Editor → http://localhost:${PORT}`);
  console.log(`Recordings   → ${RECORDINGS}`);
  const cfg = archiveConfig();
  console.log(cfg.enabled
    ? `Drive archive → ON · recordings idle >${cfg.olderThanDays}d move to ${cfg.remote}`
    : 'Drive archive → off (turn it on from the Edit tab)');
  // The timers always run; sweepArchive() re-reads the config and returns
  // immediately while it's off, so toggling it on in the UI takes effect on the
  // next tick instead of waiting for a restart. First pass is delayed so a
  // freshly-started editor stays responsive.
  const sweep = () => sweepArchive().catch(err => console.error('[archive]', err.message));
  setTimeout(sweep, 60000);
  setInterval(sweep, SWEEP_INTERVAL_MS);
});
