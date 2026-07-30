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
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(body);
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
    out.push({
      id: e.name,
      files,
      createdAt: meta.createdAt || null,
      title: meta.title || e.name,
      renderNames: meta.renderNames || {},
      compressed: meta.compressed || {},
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
        const start = m[1] ? parseInt(m[1], 10) : 0;
        const end = Math.min(m[2] ? parseInt(m[2], 10) : stat.size - 1, stat.size - 1);
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
        fs.createReadStream(filePath, { start, end })
          .on('error', () => res.destroy()).pipe(res);
        return;
      }
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(filePath).on('error', () => res.destroy()).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
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
      const file = fs.createWriteStream(path.join(dir, name));
      req.pipe(file);
      file.on('finish', () => json(res, 200, { ok: true, saved: `${id}/${name}` }));
      file.on('error', err => json(res, 500, { error: err.message }));
      return;
    }

    if (p === '/api/transcript' && req.method === 'GET') {
      const id = safeSession(url.searchParams.get('session'));
      const file = path.join(sessionDir(id), 'transcript.json');
      if (!fs.existsSync(file)) return json(res, 404, { error: 'no transcript yet' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return fs.createReadStream(file).pipe(res);
    }

    if (p === '/api/transcript' && req.method === 'POST') {
      const id = safeSession(url.searchParams.get('session'));
      const body = await readBody(req);
      const incoming = JSON.parse(body.toString()); // validate before writing
      // Stale-tab guard: if the transcript was regenerated since this editor
      // tab loaded it, refuse the save instead of clobbering the new version.
      const file = path.join(sessionDir(id), 'transcript.json');
      if (fs.existsSync(file)) {
        try {
          const disk = JSON.parse(await fsp.readFile(file, 'utf8'));
          if (disk.generatedAt && incoming.generatedAt !== disk.generatedAt) {
            return json(res, 409, { error: 'transcript was regenerated — reload the editor to get the new version (your cuts were migrated into it)' });
          }
        } catch {}
      }
      await fsp.writeFile(file, body);
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
      let trs = { words: [], settings: { padSec: 0.12, maxGapSec: 1.0 } };
      try { trs = JSON.parse(await fsp.readFile(file, 'utf8')); } catch {}
      trs.inserts = trs.inserts || [];
      trs.inserts.push({
        id: `ins-${Date.now().toString(36)}`, at, fromSession: from,
        kind: 'video', duration, label: `recorded insert (${from})`,
      });
      await fsp.writeFile(file, JSON.stringify(trs, null, 2));
      return json(res, 200, { ok: true, inserts: trs.inserts.length });
    }

    if (p === '/api/meta' && req.method === 'POST') {
      const id = safeSession(url.searchParams.get('session'));
      const patch = JSON.parse((await readBody(req)).toString());
      const file = path.join(sessionDir(id), 'meta.json');
      let meta = {};
      try { meta = JSON.parse(await fsp.readFile(file, 'utf8')); } catch {}
      if (typeof patch.title === 'string' && patch.title.trim()) meta.title = patch.title.trim();
      if (patch.renderNames && typeof patch.renderNames === 'object') {
        meta.renderNames = { ...(meta.renderNames || {}), ...patch.renderNames };
      }
      await fsp.writeFile(file, JSON.stringify(meta, null, 2));
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
        for (const f of files) {
          const kind = f.endsWith('-music.mp4') ? 'music'
            : /^clean(-[\w-]+)?\.mp4$/.test(f) ? 'clean'
            : f === 'composite.mp4' ? 'composite'
            : /^asset-[\w-]+\.(mp4|webm)$/.test(f) ? 'asset' : null; // reframe-* are intermediates
          if (!kind) continue;
          const st = await fsp.stat(path.join(dir, f)).catch(() => null);
          if (!st || !st.size) continue;
          out.push({ session: e.name, file: f, kind, size: st.size, mtime: st.mtimeMs,
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
      return fs.createReadStream(libFile).pipe(res);
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

    if (p === '/api/render' && req.method === 'DELETE') {
      const id = safeSession(url.searchParams.get('session'));
      const file = url.searchParams.get('file') || '';
      // only finished render outputs may be deleted — never the raw recordings
      const deletable = /^(clean(-[\w-]+)?\.mp4|[\w-]+-music\.mp4|composite\.mp4|reframe-[\w-]+\.mp4|asset-[\w-]+\.(mp4|webm|mov))$/;
      if (!deletable.test(file)) return json(res, 400, { error: 'not a deletable render file' });
      await fsp.unlink(path.join(sessionDir(id), file)).catch(err => { throw err; });
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
});
