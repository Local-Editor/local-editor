/* Transcript editing dashboard.
 * transcript.json schema (produced by scripts/transcribe.py):
 * {
 *   language, duration, source,
 *   settings: { padSec, maxGapSec },
 *   words: [{ w, start, end, removed, reason, edited, keepGapAfter }]
 * }
 * Cuts are word-level: render.py keeps the union of kept-word spans and
 * collapses silences longer than maxGapSec (unless keepGapAfter is set).
 */
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const params = new URLSearchParams(location.search);
let sessionId = params.get('session');
let tr = null;            // transcript object
let lastClicked = -1;     // for shift-click range cuts
let pendingCutTimer = null; // click-to-cut deferred so dblclick can cancel it
let dirty = false;

const GAP_SHOW_SEC = 1.5; // show a chip for pauses at least this long

// ---------- session picker ----------
async function loadSessions() {
  const sessions = await (await fetch('/api/sessions')).json();
  if (!sessions.length) { $('sessionList').textContent = 'No recordings yet — make one on the Record tab.'; return; }
  $('sessionList').innerHTML = sessions.map(s => `
    <p>
      <a href="editor.html?session=${encodeURIComponent(s.id)}">${esc(s.title)}</a>
      ${s.hasComposite ? '· composite ✔' : ''}
      ${s.hasTranscript ? '· transcript ✔' : '· <em>no transcript yet</em>'}
      ${s.hasClean ? '· clean.mp4 ✔' : ''}
    </p>`).join('');
}

// ---------- editor ----------
let sessName = '';

function applySessName() {
  $('sessTitle').textContent = sessName;
  $('sessTitle').title = 'Double-click to rename this recording';
  const dl = `${sessName.replace(/[^\w.-]+/g, '-')}.mp4`;
  $('dlClean').textContent = `Download “${sessName}” (clean)`;
  $('dlClean').download = dl;
}

async function openSession() {
  $('picker').classList.add('hidden');
  $('editor').classList.remove('hidden');
  $('sessTitle').textContent = sessionId;
  $('sessTitle').ondblclick = async () => {
    const name = prompt('Rename this recording:', sessName || sessionId);
    if (!name || !name.trim()) return;
    sessName = name.trim();
    await fetch(`/api/meta?session=${sessionId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: sessName }),
    });
    applySessName();
  };

  const sessions = await (await fetch('/api/sessions')).json();
  const sess = sessions.find(s => s.id === sessionId) || { files: [] };
  sessName = sess.title || sessionId;
  applySessName();
  // Prefer the raw pair (instant, no waiting on ffmpeg): screen video with
  // the webcam played on top of it in the recorded layout. The composite is
  // only used when the raw screen file is gone.
  if (sess.files.includes('screen.webm')) {
    $('player').src = `/recordings/${sessionId}/screen.webm`;
    await fixWebmDuration($('player'));
    if (sess.files.includes('webcam.webm')) await setupCamOverlay();
  } else if (sess.files.includes('composite.mp4')) {
    $('player').src = `/recordings/${sessionId}/composite.mp4`;
  } else if (sess.files.includes('webcam.webm')) {
    // webcam-only recording: the camera file is the main video
    $('player').src = `/recordings/${sessionId}/webcam.webm`;
    await fixWebmDuration($('player'));
  }
  if (sess.files.includes('clean.mp4')) {
    $('dlClean').classList.remove('hidden');
    $('dlClean').href = `/recordings/${sessionId}/clean.mp4`;
  }

  const res = await fetch(`/api/transcript?session=${sessionId}`);
  if (!res.ok) {
    $('transcript').innerHTML = `No transcript yet. <button id="mkTr" class="btn">Transcribe now</button>`;
    $('mkTr').onclick = async () => {
      if (!sess.files.includes('composite.mp4') && sess.files.includes('webcam.webm')) {
        // fine — transcribe.py prefers webcam audio anyway
      }
      $('transcript').textContent = 'Transcribing…';
      await runJob('transcribe');
      location.reload();
    };
    return;
  }
  tr = await res.json();
  tr.settings = tr.settings || { padSec: 0.12, maxGapSec: 1.0 };
  migrateCamKeyframes();
  histReset();   // undo baseline = the transcript as loaded
  renderTranscript();
  updateStats();
  tlSetup();

  // a job may already be running (page reloaded mid-render) — resume the bar
  const job = await (await fetch(`/api/job?session=${sessionId}`)).json();
  if (job.status === 'running') {
    pollJob(job.name).then(j => { if (j.status === 'done') refreshDownloadLinks(); });
  }
}

async function refreshDownloadLinks() {
  const sess = (await (await fetch('/api/sessions')).json()).find(s => s.id === sessionId);
  if (!sess) return;
  if (sess.files.includes('clean.mp4')) {
    $('dlClean').classList.remove('hidden');
    $('dlClean').href = `/recordings/${sessionId}/clean.mp4?t=${Date.now()}`;
  }
  const scored = sess.files.find(f => f.endsWith('-music.mp4'));
  if (scored) {
    $('dlMusic').classList.remove('hidden');
    $('dlMusic').href = `/recordings/${sessionId}/${scored}?t=${Date.now()}`;
  }
}

// MediaRecorder webm files report duration=Infinity in Chrome until you seek
// past the end once — without this, seeking (and therefore editing) is broken.
function fixWebmDuration(v) {
  return new Promise(resolve => {
    let done = false, handler = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (handler) v.removeEventListener('durationchange', handler);
      if (v.currentTime > 1e9) v.currentTime = 0;  // un-park after the seek trick
      resolve();
    };
    const kick = () => {
      if (v.duration && isFinite(v.duration)) { finish(); return; }
      v.currentTime = 1e10;   // force Chrome to discover the real duration
      handler = () => {
        if (isFinite(v.duration)) {
          v.currentTime = 0;
          finish();
        }
      };
      v.addEventListener('durationchange', handler);
    };
    // metadata may ALREADY be loaded (cache) — handle both orders
    if (v.readyState >= 1) kick();
    else v.addEventListener('loadedmetadata', kick, { once: true });
    setTimeout(finish, 5000);  // never wedge the editor on a stubborn file
  });
}

// ---------- webcam overlay playback (raw pair, pre-composite) ----------
let camOffset = 0; // webcam recorder started this many seconds AFTER the screen one
let camLayout = null;   // layout.json (recorder-arranged bubble)
let camAvailable = false;

async function setupCamOverlay() {
  const [layout, meta] = await Promise.all([
    fetch(`/recordings/${sessionId}/layout.json`).then(r => r.ok ? r.json() : null),
    fetch(`/recordings/${sessionId}/meta.json`).then(r => r.ok ? r.json() : {}),
  ]);
  if (!layout) return;
  camOffset = meta.webcamOffsetSec || 0;

  const cam = $('camVideo');
  cam.src = `/recordings/${sessionId}/webcam.webm`;
  await fixWebmDuration(cam);
  // only trust "no video track" when metadata actually loaded — a stalled
  // load (e.g. Chrome's 6-connections-per-host limit with several editor
  // tabs open) must not disable the bubble
  const micOnly = meta.micOnly === true || (cam.readyState >= 1 && !cam.videoHeight);
  if (!micOnly) {
    camLayout = layout;
    camAvailable = true;
    $('camOverlay').classList.remove('hidden');
    const player0 = $('player');
    const place = () => refreshCamPlacement(true);
    player0.addEventListener('loadedmetadata', place);
    window.addEventListener('resize', place);
    $('camOverlay').classList.add('editable');
    place();
  }
  // mic-only: the (hidden) cam element still plays the voice track in sync

  const player = $('player');

  // Screen video is the master; the webcam follows it.
  const syncTime = () => { cam.currentTime = Math.max(0, player.currentTime - camOffset); };
  player.addEventListener('play', () => { syncTime(); cam.play().catch(() => {}); });
  player.addEventListener('pause', () => { cam.pause(); syncTime(); });
  player.addEventListener('seeked', syncTime);
  player.addEventListener('ratechange', () => { cam.playbackRate = player.playbackRate; });
  player.addEventListener('timeupdate', () => {
    if (player.paused) return;
    const want = player.currentTime - camOffset;
    if (Math.abs(cam.currentTime - want) > 0.2) cam.currentTime = Math.max(0, want);
  });
  // Mic audio lives on the webcam file — make sure it's audible.
  cam.muted = false;
  cam.volume = 1;
}

// ---------- per-piece webcam bubble: cut the footage, then set the bubble
// for each piece — no keyframes, the placement belongs to the segment ----------
function segForSource(t) {
  return segs().find(sg => t >= sg.s0 - 0.01 && t <= sg.s1 + 0.01) || null;
}
function materializedSeg(t) {
  const sg = segForSource(t);
  if (!sg) return null;
  if (!tr.segments || !tr.segments.length) tr.segments = segs().map(x => ({ ...x }));
  return tr.segments.find(x => x.id === sg.id) || null;
}
function layoutAt(t) {
  const eff = { ...(camLayout || {}) };
  const sg = segForSource(t);
  if (sg && sg.cam) Object.assign(eff, sg.cam);
  return eff;
}
// one-time migration of the old keyframe model onto pieces
function migrateCamKeyframes() {
  const kfs = tr.camLayouts || [];
  if (!kfs.length) return;
  for (const kf of kfs.sort((a, b) => a.at - b.at)) {
    const sg = materializedSeg(kf.at);
    if (sg) sg.cam = { x: kf.x, y: kf.y, w: kf.w };
  }
  delete tr.camLayouts;
}
let appliedCamSig = '';
function refreshCamPlacement(force) {
  if (!tr || !camAvailable || $('playerStage').classList.contains('social')) return;
  if (camEdit.act) return;   // don't fight an in-progress drag
  const eff = layoutAt($('player').currentTime || 0);
  const sig = `${eff.x},${eff.y},${eff.w}`;
  if (force || sig !== appliedCamSig) {
    appliedCamSig = sig;
    placeCamOverlay(eff);
  }
}

function placeCamOverlay(layout) {
  // social-format preview positions the overlay itself
  if ($('playerStage').classList.contains('social')) return;
  const player = $('player');
  const stage = $('playerStage').getBoundingClientRect();
  const rect = player.getBoundingClientRect();
  // Letterbox-aware: find the actual video image inside the element.
  let vx = rect.left - stage.left, vy = rect.top - stage.top, vw = rect.width, vh = rect.height;
  if (player.videoWidth) {
    const scale = Math.min(rect.width / player.videoWidth, rect.height / player.videoHeight);
    vw = player.videoWidth * scale;
    vh = player.videoHeight * scale;
    vx += (rect.width - vw) / 2;
    vy += (rect.height - vh) / 2;
  }
  const w = layout.w * vw;
  const h = w / (layout.aspect || 1);
  const box = $('camOverlay');
  box.style.left = (vx + layout.x * vw) + 'px';
  box.style.top = (vy + layout.y * vh) + 'px';
  box.style.width = w + 'px';
  box.style.height = h + 'px';
  box.style.borderRadius = (layout.radius || 0) + '%';
  $('camVideo').style.transform = layout.mirror ? 'scaleX(-1)' : 'none';
}

function fmtSec(s) {
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function renderTranscript() {
  const el = $('transcript');
  el.innerHTML = '';
  const hits = searchHitSet();
  tr.words.forEach((w, i) => {
    const span = document.createElement('span');
    span.className = 'word' + (w.removed ? ' removed' : '') + (w.edited ? ' edited' : '')
      + (w.detected ? ' detected' : '') + (hits.has(i) ? ' search-hit' : '');
    if (w.detected) span.title = 'Sound Whisper couldn\'t transcribe (likely an um/breath) — click twice to cut or restore';
    span.textContent = w.w + ' ';
    span.dataset.i = i;
    if (w.removed && w.reason) span.dataset.reason = w.reason;

    span.addEventListener('pointerdown', () => { dragAnchor = i; dragLast = i; });
    span.addEventListener('pointerenter', () => {
      if (dragAnchor !== null) { dragLast = i; applyDragSel(); }
    });

    span.onclick = e => {
      if (dragJustCut) return; // a drag-cut just happened; ignore the click
      const idx = i;
      if (e.shiftKey && lastClicked >= 0) {
        const [a, b] = [Math.min(lastClicked, idx), Math.max(lastClicked, idx)];
        const target = !tr.words[idx].removed;
        for (let k = a; k <= b; k++) { tr.words[k].removed = target; tr.words[k].reason = target ? 'manual' : null; }
        markDirty(); renderTranscript(); updateStats();
      } else if (lastClicked === idx) {
        // defer so a double-click (edit text) doesn't also cut the word
        clearTimeout(pendingCutTimer);
        pendingCutTimer = setTimeout(() => {
          w.removed = !w.removed;
          w.reason = w.removed ? 'manual' : null;
          markDirty(); renderTranscript(); updateStats();
        }, 250);
      } else {
        $('player').currentTime = Math.max(0, w.start - 0.05);
        highlight(idx);
      }
      lastClicked = idx;
    };

    span.ondblclick = () => {
      clearTimeout(pendingCutTimer);   // cancel the pending click-to-cut
      const edited = prompt('Edit word (text only — timing is unchanged):', w.w);
      if (edited !== null && edited !== w.w) { w.w = edited; w.edited = true; markDirty(); renderTranscript(); }
    };

    el.appendChild(span);

    // pause chip between this word and the next
    const next = tr.words[i + 1];
    if (next && next.start - w.end >= GAP_SHOW_SEC) {
      const chip = document.createElement('span');
      const secs = (next.start - w.end).toFixed(1);
      chip.className = 'gap-chip' + (w.keepGapAfter ? ' kept' : '');
      chip.textContent = w.keepGapAfter ? `⏸ ${secs}s kept` : `✂ ${secs}s pause`;
      chip.title = 'Click to toggle keeping this pause in the final video';
      chip.onclick = () => { w.keepGapAfter = !w.keepGapAfter; markDirty(); renderTranscript(); updateStats(); };
      el.appendChild(chip);
    }
  });
}

// ---------- word search & bulk cut ----------
let searchHits = [];   // arrays of word indices, one array per phrase match
let searchCursor = -1;

const normWord = s => s.toLowerCase().replace(/[^\w']/g, '');

function runSearch() {
  const q = $('searchBox').value.trim().toLowerCase().split(/\s+/).map(normWord).filter(Boolean);
  searchHits = [];
  searchCursor = -1;
  if (q.length) {
    const normed = tr.words.map(w => w.detected ? null : normWord(w.w));
    for (let i = 0; i + q.length <= tr.words.length; i++) {
      if (q.every((t, k) => normed[i + k] === t)) searchHits.push(q.map((_, k) => i + k));
    }
  }
  const n = searchHits.length;
  $('searchCount').textContent = q.length ? `${n} match${n === 1 ? '' : 'es'}` : '';
  $('cutMatchesBtn').disabled = !n;
  $('restoreMatchesBtn').disabled = !n;
  renderTranscript();
}

let searchDebounce;
$('searchBox').addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(runSearch, 200);
});
$('searchBox').addEventListener('keydown', e => {
  if (e.key !== 'Enter' || !searchHits.length) return;
  searchCursor = (searchCursor + 1) % searchHits.length;
  const first = tr.words[searchHits[searchCursor][0]];
  $('player').currentTime = Math.max(0, first.start - 0.05);
  const el = document.querySelector(`.word[data-i="${searchHits[searchCursor][0]}"]`);
  if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  $('searchCount').textContent = `${searchCursor + 1} / ${searchHits.length}`;
});

function setMatchesRemoved(removed) {
  for (const hit of searchHits) {
    for (const i of hit) {
      tr.words[i].removed = removed;
      tr.words[i].reason = removed ? 'search' : null;
    }
  }
  markDirty(); renderTranscript(); updateStats();
}
$('cutMatchesBtn').onclick = () => setMatchesRemoved(true);
$('restoreMatchesBtn').onclick = () => setMatchesRemoved(false);

function searchHitSet() {
  const s = new Set();
  for (const hit of searchHits) for (const i of hit) s.add(i);
  return s;
}

function highlight(idx) {
  document.querySelectorAll('.word.current').forEach(e => e.classList.remove('current'));
  const el = document.querySelector(`.word[data-i="${idx}"]`);
  if (el) el.classList.add('current');
}

// follow playback + skip removed regions
$('player').addEventListener('timeupdate', () => {
  if (!tr) return;
  const t = $('player').currentTime;
  const idx = tr.words.findIndex(w => t >= w.start && t <= w.end + 0.15);
  if (idx >= 0) highlight(idx);

  if ($('skipRemoved').checked && !$('player').paused) {
    const seg = keepSegments();
    const inKeep = seg.some(([a, b]) => t >= a - 0.05 && t <= b + 0.05);
    if (!inKeep) {
      const nxt = seg.find(([a]) => a > t);
      if (nxt) $('player').currentTime = nxt[0];
    }
  }
});

// ---------- cut model (mirrors scripts/render.py) ----------
function keepSegments() {
  // A removed word ALWAYS forces a cut (pad clamped so the removed audio
  // can't leak back in); silences > maxGap collapse unless keepGapAfter.
  const pad = tr.settings.padSec, maxGap = tr.settings.maxGapSec;
  const keptIdx = tr.words.map((w, i) => w.removed ? -1 : i).filter(i => i >= 0);
  if (!keptIdx.length) return [];
  const segs = [];
  const first = tr.words[keptIdx[0]];
  let a = Math.max(0, first.start - pad), b = first.end + pad;
  let prevI = keptIdx[0];
  for (const i of keptIdx.slice(1)) {
    const w = tr.words[i], prev = tr.words[prevI];
    const removedBetween = tr.words.slice(prevI + 1, i);
    const gap = w.start - prev.end;
    if (removedBetween.length) {
      segs.push([a, Math.min(b, removedBetween[0].start)]);
      a = Math.max(w.start - pad, removedBetween[removedBetween.length - 1].end);
      b = w.end + pad;
    } else if (gap > maxGap && !prev.keepGapAfter) {
      segs.push([a, b]);
      a = Math.max(0, w.start - pad);
      b = w.end + pad;
    } else {
      b = w.end + pad;
    }
    prevI = i;
  }
  segs.push([a, b]);
  // subtract manual timeline range-cuts (mirrors common.py)
  let out = segs;
  for (const [ca, cb] of (tr.cutRanges || [])) {
    const nxt = [];
    for (const [x, y] of out) {
      if (cb <= x || ca >= y) { nxt.push([x, y]); continue; }
      if (ca > x) nxt.push([x, ca]);
      if (cb < y) nxt.push([cb, y]);
    }
    out = nxt;
  }
  return out.filter(([s, e]) => e - s > 0.02);
}

function updateStats() {
  const dur = tr.duration || $('player').duration || 0;
  const keep = keepSegments().reduce((s, [a, b]) => s + (b - a), 0);
  $('statOrig').textContent = fmtSec(dur);
  $('statClean').textContent = fmtSec(finalDuration());
  $('statRemoved').textContent = fmtSec(Math.max(0, dur - keep));
  refreshExports();
  tl.static = null; // cuts changed — timeline redraws next frame
}

// ---------- actions ----------
function markDirty() { dirty = true; $('saveBtn').textContent = 'Save transcript *'; histPush(); }

// ---------- undo / redo (⌘Z / ⇧⌘Z) ----------
// Every committed edit calls markDirty() after mutating `tr`, so the history
// is a stack of post-edit snapshots; undo walks back to the previous one.
const hist = { stack: [], idx: -1, max: 100, muted: false };

function histPush() {
  if (!tr || hist.muted) return;
  const snap = JSON.stringify(tr);
  if (hist.stack[hist.idx] === snap) return;   // no actual change
  hist.stack.length = hist.idx + 1;            // an edit invalidates the redo tail
  hist.stack.push(snap);
  if (hist.stack.length > hist.max) hist.stack.shift();
  hist.idx = hist.stack.length - 1;
}

function histReset() {
  hist.stack = tr ? [JSON.stringify(tr)] : [];
  hist.idx = hist.stack.length - 1;
}

async function histGo(dir) {
  const to = hist.idx + dir;
  if (to < 0 || to >= hist.stack.length) {
    tlToast(dir < 0 ? 'nothing to undo' : 'nothing to redo');
    return;
  }
  hist.idx = to;
  hist.muted = true;   // the re-render below calls markDirty paths — don't re-record
  try {
    tr = JSON.parse(hist.stack[to]);
    dirty = true; $('saveBtn').textContent = 'Save transcript *';
    renderTranscript(); updateStats(); tl.static = null;
    await saveTranscript();
  } finally {
    hist.muted = false;
  }
  const left = dir < 0 ? hist.idx : hist.stack.length - 1 - hist.idx;
  tlToast(dir < 0 ? `↩ undone (${left} more undo${left === 1 ? '' : 's'} available)` : '↪ redone');
}

$('saveBtn').onclick = saveTranscript;
async function saveTranscript() {
  const res = await fetch(`/api/transcript?session=${sessionId}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tr, null, 2),
  });
  if (res.status === 409) {
    // The transcript was regenerated (better model) while this tab was open.
    // Don't clobber it — re-map this tab's edits onto the new words by time.
    const fresh = await (await fetch(`/api/transcript?session=${sessionId}`)).json();
    const spans = tr.words.filter(w => w.removed).map(w => [w.start, w.end, w.reason]);
    let carried = 0;
    for (const w of fresh.words) {
      const mid = (w.start + w.end) / 2;
      const hit = spans.find(([a, b]) => a - 0.05 <= mid && mid <= b + 0.05);
      if (hit && !w.removed) { w.removed = true; w.reason = hit[2] || 'manual'; carried++; }
    }
    for (const t of tr.words.filter(w => w.keepGapAfter).map(w => w.end)) {
      const cand = fresh.words.reduce((best, w) => Math.abs(w.end - t) < Math.abs(best.end - t) ? w : best);
      if (Math.abs(cand.end - t) < 0.5) cand.keepGapAfter = true;
    }
    tr = fresh;
    tr.settings = tr.settings || { padSec: 0.12, maxGapSec: 1.0 };
    histReset();   // old snapshots carry the old generatedAt — saving them would 409
    renderTranscript(); updateStats();
    await saveTranscript();
    alert(`The transcript was re-generated with a better model while you were editing.\nYour cuts (${carried} words) were carried over onto the new transcript automatically.`);
    return;
  }
  dirty = false;
  $('saveBtn').textContent = 'Save transcript';
}

$('aiCleanBtn').onclick = async () => {
  $('aiCleanBtn').disabled = true;
  try {
    await saveTranscript();
    await runJob('enhance');
    const res = await fetch(`/api/transcript?session=${sessionId}`);
    tr = await res.json();
    histPush();   // AI clean-up lands in the undo history like any other edit
    renderTranscript(); updateStats();
  } finally {
    $('aiCleanBtn').disabled = false;
  }
};

// ---------- live format preview ----------
// Restyles the player stage to mirror what reframe.py will produce, using
// the real video streams — instant, no rendering needed.
function applyFormatPreview() {
  const [format, layout] = ($('renderFormat').value + '|cam-top').split('|');
  const stage = $('playerStage');
  const player = $('player'), ov = $('camOverlay');

  if (format === 'wide') {
    stage.classList.remove('social');
    stage.style.aspectRatio = '';
    player.style.cssText = '';
    ov.style.cssText = '';
    if (camAvailable) {
      ov.classList.remove('hidden');
      placeCamOverlay(camLayout);
    }
    return;
  }

  stage.classList.add('social');
  stage.style.aspectRatio = format === 'short' ? '9 / 16' : '1 / 1';

  if (!camAvailable || layout === 'overlay') {
    player.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;';
    if (camAvailable) {
      ov.style.cssText = 'left:auto;top:auto;right:3.5%;bottom:3.5%;width:36%;height:auto;'
        + `aspect-ratio:1;border-radius:${(camLayout && camLayout.radius) || 18}%;`;
    }
  } else {
    const camTop = layout === 'cam-top';
    player.style.cssText = 'position:absolute;left:0;width:100%;height:50%;object-fit:cover;'
      + (camTop ? 'bottom:0;' : 'top:0;');
    ov.style.cssText = 'left:0;width:100%;height:50%;border-radius:0;'
      + (camTop ? 'top:0;' : 'bottom:0;');
  }
}
$('renderFormat').onchange = applyFormatPreview;

$('renderBtn').onclick = async () => {
  $('renderBtn').disabled = true;
  let j;
  try {
    await saveTranscript();
    const [format, layout] = ($('renderFormat').value + '|cam-top').split('|');
    const quality = $('renderQuality').value;
    const compress = $('renderCompress').checked ? '&compress=1' : '';
    j = await runJob('render', `&quality=${quality}&format=${format}&layout=${layout}${compress}`);
  } finally {
    $('renderBtn').disabled = false;
  }
  const [format, layout] = ($('renderFormat').value + '|cam-top').split('|');
  if (j.status === 'done') {
    const file = format === 'wide' ? 'clean.mp4' : `clean-${format}-${layout}.mp4`;
    $('dlClean').classList.remove('hidden');
    $('dlClean').href = `/recordings/${sessionId}/${file}?t=${Date.now()}`;
    $('dlClean').textContent = `Download “${sessName}”${format === 'wide' ? '' : ` (${format})`}`;
  }
};

// ---------- background music ----------
async function loadMusic() {
  const lib = await (await fetch('/api/music')).json();
  const names = Object.keys(lib);
  if (!names.length) return; // library empty — selector stays "none"
  $('musicSelect').innerHTML = '<option value="">— none —</option>' +
    names.map(f => `<option value="${esc(f)}">${esc(lib[f].title || f)}${lib[f].feel ? ' · ' + esc(lib[f].feel) : ''}</option>`).join('');
  $('musicSelect').onchange = () => {
    $('musicBtn').disabled = !$('musicSelect').value;
    $('musicPrevBtn').disabled = !$('musicSelect').value;
    stopMusicPreview();
  };
}
loadMusic();

$('musicGain').oninput = () => { $('musicGainVal').textContent = $('musicGain').value + '%'; };

// music clip volume: linear 0–1; older clips stored dB in `gain`
function musicVol(m) {
  return m.volume ?? Math.pow(10, (m.gain ?? -21) / 20);
}

function audioDuration(url) {
  return new Promise(resolve => {
    const a = new Audio();
    a.preload = 'metadata';
    a.onloadedmetadata = () => resolve(isFinite(a.duration) ? a.duration : 0);
    a.onerror = () => resolve(0);
    a.src = url;
  });
}

// ▶ 30s — audition the selected track without touching the timeline
const audition = { el: new Audio(), timer: null };
function stopMusicPreview() {
  audition.el.pause();
  clearTimeout(audition.timer);
  $('musicPrevBtn').textContent = '▶ 30s';
}
$('musicPrevBtn').onclick = () => {
  if (!audition.el.paused) return stopMusicPreview();
  const track = $('musicSelect').value;
  if (!track) return;
  audition.el.src = `/music/${encodeURIComponent(track)}`;
  audition.el.currentTime = 0;
  audition.el.volume = 0.7;
  audition.el.play().catch(() => tlToast('couldn’t play the track preview'));
  $('musicPrevBtn').textContent = '■ Stop';
  audition.timer = setTimeout(stopMusicPreview, 30000);
};

// 🎵 Add to timeline — the track becomes a clip on a Music lane at the
// playhead: drag/trim it like any insert; render ducks it under the voice.
$('musicBtn').onclick = async () => {
  const track = $('musicSelect').value;
  if (!track) return;
  $('musicBtn').disabled = true;
  try {
    stopMusicPreview();
    // track length from the audio metadata
    const trackDur = await audioDuration(`/music/${encodeURIComponent(track)}`);
    if (!trackDur) { tlToast('couldn’t read that track — is the music library present?'); return; }
    // a dedicated Music lane, created on first use
    tlTracks();
    if (!tr.tracks.some(t => t.id === 'music')) tr.tracks.push({ id: 'music', name: 'Music' });
    const at = Math.max(0, Math.min(curTimelineTime(), Math.max(0, tlEnd() - 1)));
    const duration = Math.max(1, Math.min(trackDur, tlEnd() - at));
    const title = ($('musicSelect').selectedOptions[0] || {}).textContent || track;
    tr.inserts = tr.inserts || [];
    tr.inserts.push({
      id: `mus-${Date.now().toString(36)}`, at: Math.round(at * 10) / 10,
      kind: 'music', musicTrack: track, srcStart: 0,
      duration: Math.round(duration * 100) / 100,
      volume: (parseFloat($('musicGain').value) || 40) / 100,   // linear 0–1
      label: `🎵 ${title.split(' · ')[0]}`, track: 'music',
    });
    markDirty(); await saveTranscript(); updateStats();
    tl.static = null; tl.resize && tl.resize();
    tlToast(`🎵 “${title.split(' · ')[0]}” on the Music timeline at ${fmtSec(at)} — drag/trim it like any clip; it ducks under your voice at render`);
  } finally {
    $('musicBtn').disabled = false;
  }
};

$('undoAllBtn').onclick = () => {
  tr.words.forEach(w => { w.removed = false; w.reason = null; });
  tr.cutRanges = [];
  markDirty(); renderTranscript(); updateStats();
};

const JOB_LABELS = {
  render: 'Rendering clean video', transcribe: 'Transcribing', composite: 'Compositing',
  addmusic: 'Adding music', enhance: 'AI clean-up', subsession: 'Creating edit session',
};

// expected output length in seconds, used to turn ffmpeg/whisper logs into a %
function jobTarget(name) {
  const dur = (tr && tr.duration) || $('player').duration || 0;
  if (name === 'render' || name === 'addmusic') {
    const keep = tr ? keepSegments().reduce((s, [a, b]) => s + (b - a), 0) : 0;
    return keep || dur;
  }
  return dur; // composite / transcribe work through the full recording
}

function jobPercent(name, tail) {
  let target = jobTarget(name);
  // social renders reframe the FULL recording first, then apply cuts
  if (name === 'render' && tail.includes('building reframe') && !tail.includes('reframed:')) {
    target = (tr && tr.duration) || target;
  }
  if (!target) return null;
  // ffmpeg progress: time=HH:MM:SS.xx  |  whisper progress: [ 123.45s] text
  const ff = [...tail.matchAll(/time=(\d+):(\d+):([\d.]+)/g)].pop();
  const wh = [...tail.matchAll(/\[\s*([\d.]+)s\]/g)].pop();
  const done = ff ? (+ff[1] * 3600 + +ff[2] * 60 + +ff[3]) : (wh ? +wh[1] : null);
  if (done === null) return null;
  return Math.max(1, Math.min(99, Math.round(done / target * 100)));
}

async function runJob(name, extraQuery = '') {
  await fetch(`/api/${name}?session=${sessionId}${extraQuery}`, { method: 'POST' });
  return pollJob(name);
}

async function pollJob(name) {
  const label = JOB_LABELS[name] || name;
  $('jobProgress').classList.remove('hidden');
  $('progressFill').style.width = '2%';
  $('progressText').textContent = `${label}…`;
  $('jobCancelBtn').classList.remove('hidden');
  let misses = 0;
  for (;;) {
    await new Promise(r => setTimeout(r, 1500));
    let j;
    try {
      j = await (await fetch(`/api/job?session=${sessionId}`)).json();
      misses = 0;
    } catch {
      // transient poll failure — keep the UI alive instead of wedging it
      if (++misses < 5) { $('progressText').textContent = `${label}… (reconnecting)`; continue; }
      $('progressFill').style.width = '0%';
      $('progressText').textContent = `${label} — lost contact with the server`;
      $('jobCancelBtn').classList.add('hidden');
      return { status: 'error' };
    }
    const tail = j.tail || '';
    $('jobLog').textContent = tail;
    $('jobLog').scrollTop = $('jobLog').scrollHeight;
    if (j.status === 'running') {
      // renders are multi-pass (composite/reframe -> cut -> mix); name the
      // pass so a restarting bar reads as progress, not a stuck render
      const STAGES = { composite: 'building the full composite', reframe: 'reframing',
                       cut: 'cutting the edit', mix: 'mixing music & overlays',
                       compress: 'compressing to save space' };
      const stage = STAGES[j.stage] ? ` — ${STAGES[j.stage]}` : '';
      const pct = jobPercent(name, tail);
      if (pct !== null) {
        $('progressFill').style.width = pct + '%';
        $('progressText').textContent = `${label}${stage}… ${pct}%`;
      } else {
        $('progressText').textContent = `${label}${stage}…`;
      }
      continue;
    }
    const ok = j.status === 'done';
    $('progressFill').style.width = ok ? '100%' : '0%';
    $('progressText').textContent = ok ? `${label} — done ✔`
      : j.status === 'cancelled' ? `${label} — cancelled`
      : `${label} — failed (see details)`;
    $('jobCancelBtn').classList.add('hidden');
    return j;
  }
}

$('jobCancelBtn').onclick = async () => {
  $('jobCancelBtn').disabled = true;
  try { await fetch(`/api/job/cancel?session=${sessionId}`, { method: 'POST' }); }
  finally { $('jobCancelBtn').disabled = false; }
};

// ---------- exports ----------
function refreshExports() {
  const kept = tr.words.filter(w => !w.removed);
  const txt = kept.map(w => w.w).join(' ');
  // refreshExports runs on every edit — revoke the previous blob URLs or they
  // accumulate for the whole session
  if ($('dlTxt').href.startsWith('blob:')) URL.revokeObjectURL($('dlTxt').href);
  if ($('dlSrt').href.startsWith('blob:')) URL.revokeObjectURL($('dlSrt').href);
  $('dlTxt').href = URL.createObjectURL(new Blob([txt], { type: 'text/plain' }));
  $('dlTxt').download = `${sessionId}.txt`;

  // SRT built on CLEAN-video timing (after cuts), ~8 words per caption
  const segs = keepSegments();
  const toClean = t => {
    let acc = 0;
    for (const [a, b] of segs) {
      if (t <= b) return acc + Math.max(0, t - a);
      acc += b - a;
    }
    return acc;
  };
  const ts = t => {
    const ms = Math.round(t * 1000);
    const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60,
          s = Math.floor(ms / 1000) % 60, r = ms % 1000;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(r).padStart(3,'0')}`;
  };
  let srt = '', n = 1;
  for (let i = 0; i < kept.length; i += 8) {
    const grp = kept.slice(i, i + 8);
    srt += `${n++}\n${ts(toClean(grp[0].start))} --> ${ts(toClean(grp[grp.length-1].end))}\n${grp.map(w => w.w).join(' ')}\n\n`;
  }
  $('dlSrt').href = URL.createObjectURL(new Blob([srt], { type: 'text/plain' }));
  $('dlSrt').download = `${sessionId}.srt`;
}

// ---------- bottom timeline bar ----------
const tl = { dur: 0, drag: null, sel: null, raf: 0, static: null, view: null,
             expandedLane: null, expandAll: false, insDrag: null, laneClick: null,
             segDrag: null, trimDrag: null, snapAt: null,
             snapEnabled: localStorage.getItem('studio-snap') !== 'off',
             selectedLane: -1 };  // -1 = main track; >=0 = insert timeline index

// the timeline axis: the ARRANGEMENT (segments with gaps + overlays)
function tlDur() {
  if (!tr) return $('player').duration || 0;
  return Math.max(tlEnd(), 1);
}

// visible window [start, start+len] in seconds; null view = whole recording
function tlView() {
  const dur = tlDur();
  if (!tl.view) return { start: 0, len: dur };
  // cuts/trims/deletes can shrink the timeline underneath a zoomed view,
  // which would leave the canvas showing empty space — clamp to what exists
  if (tl.view.start + tl.view.len > dur + 0.01) {
    const len = Math.min(tl.view.len, dur);
    const start = Math.max(0, Math.min(dur - len, tl.view.start));
    tl.view = len >= dur - 0.01 ? null : { start, len };
    if (!tl.view) return { start: 0, len: dur };
  }
  return tl.view;
}

function tlSetView(start, len) {
  const dur = tlDur();
  len = Math.max(3, Math.min(dur, len));
  start = Math.max(0, Math.min(dur - len, start));
  tl.view = len >= dur - 0.01 ? null : { start, len };
  tl.static = null;
  const pan = $('tlPan');
  if (tl.view) {
    pan.max = (dur - len).toFixed(1);
    pan.value = start;
    pan.disabled = false;
    $('tlZoomLabel').textContent = `×${(dur / len).toFixed(1)} · showing ${fmtSec(len)}`;
  } else {
    pan.max = 0; pan.value = 0; pan.disabled = true;
    $('tlZoomLabel').textContent = '';
  }
}

// dragging before the start extends the timeline: shift everything right
function normalizeTimeline() {
  let minPos = 0;
  for (const sg of (tr.segments || [])) minPos = Math.min(minPos, sg.pos);
  for (const i of (tr.inserts || [])) minPos = Math.min(minPos, i.at);
  if (minPos < -0.01) {
    for (const sg of (tr.segments || [])) sg.pos = Math.round((sg.pos - minPos) * 100) / 100;
    for (const i of (tr.inserts || [])) i.at = Math.round((i.at - minPos) * 100) / 100;
    tlToast(`timeline extended by ${fmtSec(-minPos)} at the front`);
  }
}

function tlSetup() {
  $('timelineBar').classList.remove('hidden');
  const c = $('timeline');
  const resize = () => {
    // lane heights vary (expanded lane is taller) above the 50px main track
    c.style.height = (50 + laneMetrics().total) + 'px';
    const dpr = devicePixelRatio || 1;
    c.width = c.clientWidth * dpr;
    c.height = c.clientHeight * dpr;
    tl.static = null;
    tlRedrawStatic();
  };
  tl.resize = resize;
  window.addEventListener('resize', resize);
  resize();
  cancelAnimationFrame(tl.raf);
  const loop = () => { tlFrame(); tl.raf = requestAnimationFrame(loop); };
  loop();
  setupTimelineContextMenu();

  const timeAt = e => {
    const r = c.getBoundingClientRect();
    const v = tlView();
    return v.start + Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * v.len;
  };
  // unclamped: drags may leave the canvas (negative = extend at the front)
  const timeAtRaw = e => {
    const r = c.getBoundingClientRect();
    const v = tlView();
    return v.start + ((e.clientX - r.left) / r.width) * v.len;
  };

  // ---------- snapping: align dragged edges to nearby clips + word boundaries ----------
  // Build snap points on the COMPOSED timeline, excluding the item being dragged.
  function snapPoints(exclude) {
    const pts = [0, tlEnd()];
    for (const sg of segs()) {
      if (sg.id === exclude) continue;
      pts.push(sg.pos, sg.pos + segLen(sg));
    }
    for (const i of (tr.inserts || [])) {
      if (i.id === exclude) continue;
      pts.push(i.at, i.at + effDur(i));
    }
    // transcript word boundaries — including mid-transcript, mapped to composed time
    const v = tlView();
    for (const w of tr.words) {
      if (w.removed) continue;
      const a = compOf(w.start), b = compOf(w.end);
      if (a >= v.start - v.len && a <= v.start + v.len * 2) pts.push(a);
      if (b >= v.start - v.len && b <= v.start + v.len * 2) pts.push(b);
    }
    return pts;
  }
  function snapThreshold() {
    const v = tlView();
    const r = c.getBoundingClientRect();
    return (8 / r.width) * v.len;   // 8px in seconds at this zoom
  }
  // snap a block [start, start+len] by moving its leading OR trailing edge to
  // the nearest snap point within ~8px. Returns the adjusted start; sets tl.snapAt.
  function snapBlock(start, len, exclude) {
    if (!tl.snapEnabled) { tl.snapAt = null; return start; }
    const thresh = snapThreshold();
    const pts = snapPoints(exclude);
    let best = null;
    // evaluate leading and trailing edge against every point; pick smallest shift
    for (const p of pts) {
      const dLead = Math.abs(start - p);
      if (best === null || dLead < best.d) best = { d: dLead, start: p, at: p };
      const dTrail = Math.abs((start + len) - p);
      if (dTrail < best.d) best = { d: dTrail, start: p - len, at: p };
    }
    if (best && best.d <= thresh) { tl.snapAt = best.at; return best.start; }
    tl.snapAt = null;
    return start;
  }
  // snap a single edge value to the nearest snap point (used when trimming)
  function snapEdge(t, exclude) {
    if (!tl.snapEnabled) { tl.snapAt = null; return t; }
    const thresh = snapThreshold();
    let best = null;
    for (const p of snapPoints(exclude)) {
      const d = Math.abs(t - p);
      if (best === null || d < best.d) best = { d, p };
    }
    if (best && best.d <= thresh) { tl.snapAt = best.p; return best.p; }
    tl.snapAt = null;
    return t;
  }

  // zoom: wheel (around the cursor), buttons (around playhead/centre), pan slider
  c.addEventListener('wheel', e => {
    e.preventDefault();
    const v = tlView();
    const f = e.deltaY < 0 ? 1 / 1.3 : 1.3;
    const t = timeAt(e);
    const len = v.len * f;
    tlSetView(t - (t - v.start) * (len / v.len), len);
  }, { passive: false });
  const zoomBy = f => {
    const v = tlView();
    const t = $('player').currentTime || v.start + v.len / 2;
    const centre = (t >= v.start && t <= v.start + v.len) ? t : v.start + v.len / 2;
    const len = v.len * f;
    tlSetView(centre - (centre - v.start) * (len / v.len), len);
  };
  $('tlZoomIn').onclick = () => zoomBy(1 / 2);
  $('tlZoomOut').onclick = () => zoomBy(2);
  $('tlZoomFit').onclick = () => tlSetView(0, tlDur());
  $('tlScissor').onclick = async () => {
    const t = $('player').currentTime;
    const sg = segs().find(x => t > x.s0 + 0.2 && t < x.s1 - 0.2);
    if (!sg) { tlToast('move the playhead inside a piece of footage to split it'); return; }
    const real = tr.segments.find(x => x.id === sg.id);
    tr.segments.push({
      id: `seg${Date.now().toString(36)}`,
      s0: t, s1: real.s1, pos: real.pos + (t - real.s0),
    });
    real.s1 = t;
    markDirty(); await saveTranscript(); updateStats();
    tl.static = null;
    tlToast(`✂ footage split at ${fmtSec(compOf(t))} — drag the pieces to rearrange (select an overlay timeline first to enter arrange mode)`);
  };
  const applySnapBtn = () => {
    $('tlSnap').textContent = tl.snapEnabled ? '🧲 Snap' : '🧲 Snap off';
    $('tlSnap').style.opacity = tl.snapEnabled ? '1' : '0.5';
  };
  $('tlSnap').onclick = () => {
    tl.snapEnabled = !tl.snapEnabled;
    localStorage.setItem('studio-snap', tl.snapEnabled ? 'on' : 'off');
    if (!tl.snapEnabled) tl.snapAt = null;
    applySnapBtn();
    tlToast(tl.snapEnabled ? 'snapping on' : 'snapping off');
  };
  applySnapBtn();
  $('tlExpandAll').onclick = () => {
    tl.expandAll = !tl.expandAll;
    if (tl.expandAll) tl.expandedLane = null;
    $('tlExpandAll').textContent = tl.expandAll ? '⤡ All' : '⤢ All';
    resize();
  };
  $('tlPan').addEventListener('input', e => {
    const v = tlView();
    if (tl.view) tlSetView(parseFloat(e.target.value), v.len);
  });
  const laneY = e => e.clientY - c.getBoundingClientRect().top;

  // which edge of [a,b] is the cursor within ~7px of? 'left' | 'right' | null
  function edgeHit(e, a, b) {
    const r = c.getBoundingClientRect();
    const v = tlView();
    const px = e.clientX - r.left;
    const xa = (a - v.start) / v.len * r.width;
    const xb = (b - v.start) / v.len * r.width;
    if (Math.abs(px - xa) <= 7 && b - a > 0) return 'left';
    if (Math.abs(px - xb) <= 7 && b - a > 0) return 'right';
    return null;
  }
  // find a clip on `lane` whose left/right edge is near the cursor (by proximity,
  // so hitting the exact edge works even when the cursor isn't inside the clip)
  function clipEdgeAt(e, lane) {
    for (const ins of (tr.inserts || [])) {
      if (trackIndex(ins) !== lane) continue;
      const edge = edgeHit(e, ins.at, ins.at + effDur(ins));
      if (edge) return { ins, edge };
    }
    return null;
  }
  function segEdgeAt(e) {
    for (const sg of segs()) {
      const edge = edgeHit(e, sg.pos, sg.pos + segLen(sg));
      if (edge) return { sg, edge };
    }
    return null;
  }

  // hover: show a resize cursor over trimmable clip/segment edges
  c.addEventListener('pointermove', e => {
    if (tl.insDrag || tl.segDrag || tl.trimDrag || tl.drag) return;
    const lane = laneAt(laneY(e));
    const edge = lane >= 0 ? clipEdgeAt(e, lane) : segEdgeAt(e);
    c.style.cursor = edge ? 'ew-resize' : 'crosshair';
  });

  c.addEventListener('pointerdown', e => {
    if (e.button !== 0) return; // right-click is the insert context menu
    // Gestures: drag a block edge = TRIM · drag a block = MOVE · ⇧-drag = cut-select
    const lane = laneAt(laneY(e));
    if (lane >= 0) {
      const hit = !e.shiftKey ? clipEdgeAt(e, lane) : null;
      const ins = hit ? hit.ins : insertAtComp(timeAt(e), lane);
      if (hit) {
        if (hit.ins.kind === 'music' && hit.ins.loop) {
          // grabbing an edge means the user wants a manual length
          hit.ins.duration = Math.round(effDur(hit.ins) * 100) / 100;
          hit.ins.loop = false;
          hit.ins.label = (hit.ins.label || '').replace(' 🔁', '');
          tlToast('🔁 loop off — trimming sets a manual length');
        }
        tl.trimDrag = { kind: 'ins', ins: hit.ins, edge: hit.edge, x0: e.clientX, moved: false,
                        at0: hit.ins.at, dur0: hit.ins.duration || 0, src0: hit.ins.srcStart || 0 };
      } else if (e.shiftKey) {
        // ⇧-drag = cut-select, wherever you are: select this timeline and start the band
        if (tl.selectedLane !== lane) { tl.selectedLane = lane; tl.expandedLane = lane; tl.resize(); }
        tl.drag = { t0: timeAt(e), x0: e.clientX, moved: false };
      } else if (ins) {
        tl.insDrag = { ins, x0: e.clientX, y0: e.clientY, moved: false,
                       at0: ins.at, t0: timeAtRaw(e) };  // grab offset, so the clip doesn't snap its left edge to the cursor
      } else if (lane === tl.selectedLane) {
        tl.drag = { t0: timeAt(e), x0: e.clientX, moved: false };
      } else {
        tl.laneClick = { lane, x0: e.clientX };
      }
      try { c.setPointerCapture(e.pointerId); } catch {}
      return;
    }
    // main track area
    const segHit = !e.shiftKey ? segEdgeAt(e) : null;
    const sg = segHit ? segHit.sg : segAtTimeline(timeAt(e));
    if (segHit) {
      const real = tr.segments && tr.segments.find(x => x.id === segHit.sg.id);
      if (real) tl.trimDrag = { kind: 'seg', sg: real, edge: segHit.edge, x0: e.clientX,
                                moved: false, s0: real.s0, s1: real.s1, pos0: real.pos };
      else { // segment not yet materialized — do it now
        tr.segments = segs().map(x => ({ ...x }));
        const r2 = tr.segments.find(x => x.id === segHit.sg.id);
        tl.trimDrag = { kind: 'seg', sg: r2, edge: segHit.edge, x0: e.clientX,
                        moved: false, s0: r2.s0, s1: r2.s1, pos0: r2.pos };
      }
    } else if (e.shiftKey) {
      // ⇧-drag on the main track = cut-select there, even if a lane was selected
      if (tl.selectedLane !== -1) { tl.selectedLane = -1; tl.expandedLane = null; tl.resize(); }
      tl.drag = { t0: timeAt(e), x0: e.clientX, moved: false };
    } else if (sg) {
      // dragging footage moves it — always
      const real = tr.segments.find(x => x.id === sg.id);
      tl.segDrag = { sg: real, t0: timeAt(e), pos0: real.pos, x0: e.clientX,
                     y0: e.clientY, moved: false };
    } else if (tl.selectedLane === -1) {
      tl.drag = { t0: timeAt(e), x0: e.clientX, moved: false }; // empty area: cut band
    } else {
      tl.laneClick = { lane: -1, x0: e.clientX };  // click selects main
    }
    try { c.setPointerCapture(e.pointerId); } catch {}
  });

  c.addEventListener('pointermove', e => {
    if (tl.trimDrag) {
      const d = tl.trimDrag;
      if (Math.abs(e.clientX - d.x0) > 3) d.moved = true;
      if (d.moved) {
        const raw = timeAtRaw(e);
        if (d.kind === 'ins') {
          const ins = d.ins;
          if (d.edge === 'right') {
            // trim out-point: change duration, keeping `at` fixed
            const end = snapEdge(raw, ins.id);
            ins.duration = Math.max(0.2, Math.round((end - ins.at) * 100) / 100);
          } else {
            // trim in-point: move `at` + srcStart together, right edge stays
            const rightFixed = d.at0 + d.dur0;
            let start = snapEdge(raw, ins.id);
            start = Math.min(start, rightFixed - 0.2);
            const delta = start - d.at0;
            ins.at = Math.round(start * 100) / 100;
            ins.srcStart = Math.max(0, Math.round((d.src0 + delta) * 100) / 100);
            ins.duration = Math.max(0.2, Math.round((rightFixed - start) * 100) / 100);
          }
        } else {
          const sg = d.sg;
          if (d.edge === 'right') {
            const end = snapEdge(raw, sg.id);
            sg.s1 = Math.max(sg.s0 + 0.2, Math.round((d.s0 + (end - d.pos0)) * 100) / 100);
          } else {
            const rightFixedPos = d.pos0 + (d.s1 - d.s0);
            let start = snapEdge(raw, sg.id);
            start = Math.min(start, rightFixedPos - 0.2);
            const delta = start - d.pos0;
            sg.pos = Math.round(start * 100) / 100;
            sg.s0 = Math.max(0, Math.round((d.s0 + delta) * 100) / 100);
          }
        }
        tl.static = null;
      }
      return;
    }
    if (tl.insDrag) {
      if (Math.abs(e.clientX - tl.insDrag.x0) > 4 || Math.abs(e.clientY - tl.insDrag.y0) > 4) {
        tl.insDrag.moved = true;
      }
      if (tl.insDrag.moved) {
        const { ins, at0, t0 } = tl.insDrag;
        const raw = at0 + (timeAtRaw(e) - t0);   // move by delta from the grab point
        const snapped = snapBlock(raw, effDur(ins), ins.id);
        ins.at = tl.snapAt !== null ? snapped : Math.round(snapped * 10) / 10;
        const lane = laneAt(laneY(e));
        if (lane >= 0) ins.track = tlTracks()[lane].id;
        tl.static = null;
      }
      return;
    }
    if (tl.segDrag) {
      if (Math.abs(e.clientX - tl.segDrag.x0) > 4) tl.segDrag.moved = true;
      if (tl.segDrag.moved) {
        const sg = tl.segDrag.sg;
        const raw = tl.segDrag.pos0 + (timeAtRaw(e) - tl.segDrag.t0);
        sg.pos = snapBlock(raw, segLen(sg), sg.id); // may go negative — normalized on drop
        tl.static = null;
      }
      return;
    }
    if (!tl.drag) return;
    if (Math.abs(e.clientX - tl.drag.x0) > 4) tl.drag.moved = true;
    if (tl.drag.moved) {
      const t1 = timeAt(e);
      tl.sel = [Math.min(tl.drag.t0, t1), Math.max(tl.drag.t0, t1)];
      $('tlActions').classList.add('hidden');
    }
  });

  c.addEventListener('pointerup', async e => {
    if (tl.trimDrag) {
      const d = tl.trimDrag;
      tl.trimDrag = null;
      tl.snapAt = null;
      tl.static = null;
      if (d.moved) {
        normalizeTimeline();
        let note = '';
        if (d.kind === 'seg') {
          // a footage trim removes content from the arrangement — keep the
          // transcript honest about it, and be loud about big trims
          syncWordsToArrangement();
          renderTranscript();
          const delta = (d.s1 - d.s0) - segLen(d.sg);
          note = delta > 0.05 ? ` — ${fmtSec(delta)} trimmed off` :
                 delta < -0.05 ? ` — ${fmtSec(-delta)} extended` : '';
        }
        markDirty(); await saveTranscript(); updateStats();
        tlToast(`✂ trimmed${note} — ⌘Z to undo`);
      }
      return;
    }
    if (tl.insDrag) {
      const { ins, moved, x0, at0, t0 } = tl.insDrag;
      tl.insDrag = null;
      tl.static = null;
      if (moved || Math.abs(e.clientX - x0) > 4) {
        const snapped = snapBlock(at0 + (timeAtRaw(e) - t0), effDur(ins), ins.id);
        ins.at = tl.snapAt !== null ? snapped : Math.round(snapped * 10) / 10;
        tl.snapAt = null;
        const lane = laneAt(laneY(e));
        if (lane >= 0) ins.track = tlTracks()[lane].id;
        normalizeTimeline();
        markDirty(); await saveTranscript(); updateStats();
        tlToast(`insert moved to ${fmtSec(Math.max(0, ins.at))} · ${tlTracks()[trackIndex(ins)].name}`);
      } else {
        // clicking a clip selects its timeline AND moves the playhead there
        const lane = trackIndex(ins);
        tl.selectedLane = lane;
        tl.expandedLane = lane;
        tl.resize();
        seekTimeline(timeAt(e));
        tlToast(`“${tlTracks()[lane].name}” selected — drags now cut here`);
      }
      return;
    }
    if (tl.segDrag) {
      const { sg, moved, t0: clickT, x0: dragX0 } = tl.segDrag;
      tl.segDrag = null;
      tl.static = null;
      if (!moved && Math.abs(e.clientX - dragX0) <= 4) {
        // plain click on footage: select the main timeline and jump there
        if (tl.selectedLane !== -1) { tl.selectedLane = -1; tl.expandedLane = null; tl.resize(); }
        seekTimeline(clickT);
        return;
      }
      if (moved) {
        const dropLane = laneAt(laneY(e));
        if (dropLane >= 0) {
          // dropped on an overlay timeline: footage piece becomes a clip there
          tr.segments = (tr.segments || []).filter(x => x.id !== sg.id);
          tr.inserts = tr.inserts || [];
          tr.inserts.push({
            id: `ins-${Date.now().toString(36)}`,
            at: Math.round(timeAtRaw(e) * 10) / 10,
            file: 'composite.mp4', srcStart: sg.s0,
            kind: 'video', duration: Math.round(segLen(sg) * 100) / 100,
            label: `footage ${fmtSec(sg.s0)}–${fmtSec(sg.s1)}`,
            track: tlTracks()[dropLane].id,
          });
          normalizeTimeline();
          markDirty(); await saveTranscript(); updateStats();
          tlToast(`footage piece moved onto “${tlTracks()[dropLane].name}” as a clip`);
          return;
        }
        // resolve overlaps: snap next to the nearest free edge
        for (const other of segs()) {
          if (other.id === sg.id) continue;
          const oA = other.pos, oB = other.pos + segLen(other);
          const a = sg.pos, b = sg.pos + segLen(sg);
          if (b > oA && a < oB) {
            sg.pos = (a + b) / 2 < (oA + oB) / 2
              ? oA - segLen(sg) : oB;
          }
        }
        normalizeTimeline();
        tl.snapAt = null;
        markDirty(); await saveTranscript(); updateStats();
        tlToast(`footage moved to ${fmtSec(Math.max(0, sg.pos))}`);
      }
      tl.snapAt = null;
      return;
    }
    if (tl.laneClick) {
      const { lane } = tl.laneClick;
      tl.laneClick = null;
      if (lane === -1) {
        tl.selectedLane = -1;
        tl.expandedLane = null;
        tl.resize();
        seekTimeline(timeAt(e));
        return;
      }
      if (tl.selectedLane === lane) {
        // click the selected timeline again: back to the main track
        tl.selectedLane = -1;
        tl.expandedLane = null;
      } else {
        // select this timeline (blue = cut target) and expand it
        tl.selectedLane = lane;
        tl.expandedLane = lane;
        tlToast(`“${tlTracks()[lane].name}” selected — drags now cut on this timeline (click it again for the main track)`);
      }
      tl.resize();
      seekTimeline(timeAt(e));
      return;
    }
    if (!tl.drag) return;
    const t = timeAt(e);
    // decide drag-vs-click from the release position too — synthetic drags
    // (and very fast ones) can skip pointermove entirely
    const wasDrag = tl.drag.moved || Math.abs(e.clientX - tl.drag.x0) > 4;
    if (wasDrag) tl.sel = [Math.min(tl.drag.t0, t), Math.max(tl.drag.t0, t)];
    tl.drag = null;
    if (wasDrag && tl.sel && tl.sel[1] - tl.sel[0] > 0.05) {
      const act = $('tlActions');
      $('tlCutBtn').textContent = tl.selectedLane >= 0
        ? `✂ Cut on “${tlTracks()[tl.selectedLane].name}”`
        : '✂ Cut range';
      act.classList.remove('hidden');
      const bar = $('timelineBar').getBoundingClientRect();
      act.style.left = Math.min(e.clientX - bar.left, bar.width - 220) + 'px';
      act.style.top = '-46px';
    } else {
      // clicking the footage selects the main timeline
      if (tl.selectedLane !== -1) {
        tl.selectedLane = -1;
        tl.expandedLane = null;
        tl.resize();
      }
      const loc = locate(t);
      if (loc.type === 'base') {
        const bt = loc.t;
        const hit = (tr.cutRanges || []).findIndex(([a, b]) => bt >= a && bt <= b);
        if (hit >= 0) {
          tr.cutRanges.splice(hit, 1);
          markDirty(); tlRedrawStatic(); updateStats();
        } else {
          seekTimeline(t);
        }
      } else {
        seekTimeline(t);   // click a gap: park the playhead right there
      }
      tl.sel = null;
    }
  });
}

$('tlCutBtn').onclick = () => {
  if (!tl.sel) return;

  // cutting is scoped to the SELECTED timeline
  if (tl.selectedLane >= 0) {
    const [s0, s1] = tl.sel;
    let cutTotal = 0;
    for (const ins of (tr.inserts || [])) {
      if (trackIndex(ins) !== tl.selectedLane) continue;
      const e0 = Math.max(s0, ins.at), e1 = Math.min(s1, ins.at + effDur(ins));
      if (e1 - e0 < 0.05) continue;
      const ra = Math.round(rawOfEff(ins, e0 - ins.at) * 100) / 100;
      const rb = Math.round(rawOfEff(ins, e1 - ins.at) * 100) / 100;
      ins.cuts = [...(ins.cuts || []), [ra, rb]];
      cutTotal += e1 - e0;
    }
    tl.sel = null;
    $('tlActions').classList.add('hidden');
    if (cutTotal > 0) {
      markDirty(); saveTranscript(); updateStats(); tlRedrawStatic();
      tlToast(`✂ cut ${fmtSec(cutTotal)} from “${tlTracks()[tl.selectedLane].name}”`);
    } else {
      tlToast('nothing on the selected timeline in that range');
    }
    return;
  }

  // main track: cut the selected TIMELINE span out of the arrangement —
  // trim/split/remove the pieces it touches, then ripple-close the hole.
  // The cut is piece-local, NOT a global source-time cut: when the same
  // source material appears in more than one piece (a duplicated or
  // trimmed-out copy), cutting it here must not delete it everywhere.
  const [c0, c1] = tl.sel;
  const cutLen = c1 - c0;
  tl.sel = null; $('tlActions').classList.add('hidden');
  if (cutLen < 0.05) { tlToast('nothing to cut in that stretch of the timeline'); return; }

  tr.segments = segs();   // materialize + sort
  const out = [];
  for (const sg of tr.segments) {
    const p0 = sg.pos, p1 = sg.pos + segLen(sg);
    if (p1 <= c0 + 1e-6 || p0 >= c1 - 1e-6) { out.push(sg); continue; }  // untouched
    if (p0 < c0)   // the part before the selection survives
      out.push({ ...sg, s1: sg.s0 + (c0 - p0) });
    if (p1 > c1)   // the part after survives (new id if the head also survived)
      out.push({ ...sg, id: p0 < c0 ? `seg${Date.now().toString(36)}-${out.length}` : sg.id,
                 s0: sg.s0 + (c1 - p0), pos: c1 });
  }
  if (!out.length) { tlToast("that would cut the entire timeline — delete pieces individually instead"); return; }

  // ripple: everything at/after the cut moves left to close the hole
  for (const sg of out) if (sg.pos >= c1 - 1e-6) sg.pos = Math.round((sg.pos - cutLen) * 1000) / 1000;
  for (const ins of (tr.inserts || [])) {
    if (ins.at >= c1 - 1e-6) ins.at = Math.round((ins.at - cutLen) * 100) / 100;
    else if (ins.at > c0) ins.at = Math.round(c0 * 100) / 100;   // started inside the cut: lands at the seam
  }
  tr.segments = out;
  syncWordsToArrangement();
  markDirty(); saveTranscript(); renderTranscript(); updateStats(); tl.static = null; tlRedrawStatic();
  tlToast(`✂ removed ${fmtSec(cutLen)} from the timeline — ⌘Z to undo`);
};

// strike words whose source time no longer appears in ANY piece, so the
// transcript mirrors the timeline; never un-removes existing cuts
function syncWordsToArrangement() {
  const ss = segs();
  tr.words.forEach(w => {
    const mid = (w.start + w.end) / 2;
    if (!w.removed && !ss.some(sg => mid >= sg.s0 - 0.05 && mid <= sg.s1 + 0.05)) {
      w.removed = true; w.reason = 'manual';
    }
  });
}

let toastTimer;
function tlToast(msg) {
  const el = $('tlToast');
  el.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.textContent = '', 6000);
}
$('tlCancelBtn').onclick = () => { tl.sel = null; $('tlActions').classList.add('hidden'); };

// ---------- inserts: right-click to add recordings / media at a point ----------
let ctxTarget = { t: 0, ins: null, lane: -1 };

function tlTracks() {
  if (!tr.tracks || !tr.tracks.length) tr.tracks = [{ id: 't1', name: 'Inserts' }];
  return tr.tracks;
}
function trackIndex(ins) {
  const i = tlTracks().findIndex(t => t.id === ins.track);
  return i >= 0 ? i : 0;
}
// ---------- composed timeline: base recording + inserts occupy real time ----------
// Inserts can carry their own cut ranges (ins.cuts, RAW insert-local time);
// all composition math uses the EFFECTIVE (post-cut) duration.
function insCuts(ins) {
  // sorted AND merged — overlapping ranges would double-count in effDur
  const sorted = (ins.cuts || []).slice().sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [a, b] of sorted) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1] + 0.01) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}
function effDur(ins) {
  // a looped music bed follows the timeline end as the edit changes
  if (ins.kind === 'music' && ins.loop) return Math.max(1, tlEndSolid() - ins.at);
  return Math.max(0, (ins.duration || 0) - insCuts(ins).reduce((s, [a, b]) => s + (b - a), 0));
}

// timeline end from footage + fixed-length inserts only — looped music beds
// derive their length from this, so they must not feed back into it
function tlEndSolid() {
  let end = 0;
  for (const sg of segs()) end = Math.max(end, sg.pos + segLen(sg));
  for (const i of (tr.inserts || [])) {
    if (i.kind === 'music' && i.loop) continue;
    end = Math.max(end, i.at + effDur(i));
  }
  return end;
}
function rawOfEff(ins, e) {  // effective offset -> raw file offset
  let raw = e;
  for (const [a, b] of insCuts(ins)) if (raw >= a) raw += b - a;
  return raw;
}
function effOfRaw(ins, r) {  // raw file offset -> effective offset
  let e = r;
  for (const [a, b] of insCuts(ins)) {
    if (r >= b) e -= b - a;
    else if (r > a) e -= r - a;
  }
  return e;
}

function insList(excludeId) {
  return (tr.inserts || []).filter(i => i.id !== excludeId)
    .slice().sort((a, b) => a.at - b.at || trackIndex(a) - trackIndex(b));
}
function insTotal() {
  return (tr.inserts || []).reduce((s, i) => s + effDur(i), 0);
}

// ---------- main-track segments (scissor splits; draggable arrangement) ----------
function segs() {
  if (!tr.segments || !tr.segments.length) {
    tr.segments = [{ id: 'seg1', s0: 0, s1: tr.duration || 0, pos: 0 }];
  }
  return tr.segments.slice().sort((a, b) => a.pos - b.pos);
}
function segLen(sg) { return Math.max(0, sg.s1 - sg.s0); }

// timeline end = furthest of segments and overlays
function tlEnd() {
  let end = 0;
  for (const sg of segs()) end = Math.max(end, sg.pos + segLen(sg));
  for (const i of (tr.inserts || [])) end = Math.max(end, i.at + effDur(i));
  return end;
}
// base (source) time -> timeline position
function compOf(t) {
  for (const sg of segs()) if (t >= sg.s0 - 0.001 && t <= sg.s1 + 0.001) {
    return sg.pos + (t - sg.s0);
  }
  return t;
}
// timeline position -> what lives on the MAIN track there
function locate(c) {
  for (const sg of segs()) {
    if (c >= sg.pos && c < sg.pos + segLen(sg)) {
      return { type: 'base', t: sg.s0 + (c - sg.pos), seg: sg };
    }
  }
  return { type: 'gap', t: null, next: segs().find(sg => sg.pos > c) || null };
}
function segAtTimeline(c) {
  return segs().find(sg => c >= sg.pos && c < sg.pos + segLen(sg)) || null;
}
// ALL overlays covering a timeline position, top-first (lower lane index wins).
// Music clips are audio beds, not visual overlays — they never claim the frame.
function overlaysAt(c) {
  const hits = (tr.inserts || []).filter(i => i.kind !== 'music' && c >= i.at && c < i.at + effDur(i));
  hits.sort((a, b) => trackIndex(a) - trackIndex(b));
  return hits;
}
function overlayAt(c) { return overlaysAt(c)[0] || null; }
// estimated FINAL rendered duration: per-segment kept material + gaps + overlay tails
function finalDuration() {
  const keeps = keepSegments();
  let total = 0, cursor = 0;
  for (const sg of segs()) {
    total += Math.max(0, sg.pos - cursor); // gap becomes black screen
    for (const [a, b] of keeps) {
      total += Math.max(0, Math.min(b, sg.s1) - Math.max(a, sg.s0));
    }
    cursor = sg.pos + segLen(sg);
  }
  for (const i of (tr.inserts || [])) {
    // overlays never shorten the video but can extend past the end
    total = Math.max(total, total + (i.at + effDur(i) - tlEnd()));
  }
  return total;
}

// ---------- lanes (click a lane to expand it; others shrink) ----------
function laneMetrics() {
  const tracks = tlTracks();
  const hs = tracks.map((_, i) =>
    tl.expandAll ? 30 :
    tl.expandedLane == null ? 13 : (i === tl.expandedLane ? 30 : 8));
  let y = 2;
  const lanes = hs.map(h => { const o = { y, h }; y += h; return o; });
  return { lanes, total: y + 2 };
}
function laneAt(yPx) {
  const { lanes } = laneMetrics();
  return lanes.findIndex(l => yPx >= l.y && yPx < l.y + l.h);
}
function insertAtComp(c, lane) {
  return (tr.inserts || []).find(i => trackIndex(i) === lane
    && c >= i.at && c <= i.at + Math.max(0.5, effDur(i))) || null;
}

// open a menu at (x, y), flipped up/left as needed to stay inside the viewport
function placeMenu(menu, x, y) {
  // the timeline bar's backdrop-filter makes it a containing block for
  // position:fixed — menus must live on <body> to use viewport coordinates
  if (menu.parentElement !== document.body) document.body.appendChild(menu);
  menu.style.position = 'fixed';
  menu.classList.remove('hidden');
  const w = menu.offsetWidth, h = menu.offsetHeight;   // forces layout
  let left = x + 4;
  if (left + w > innerWidth - 12) left = Math.max(8, x - w - 4);
  let top = y + 6;
  if (top + h > innerHeight - 12) top = Math.max(8, y - h - 6);  // flip above the cursor
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
}

function setupTimelineContextMenu() {
  const c = $('timeline');
  c.addEventListener('contextmenu', e => {
    e.preventDefault();
    if (!tr) return;
    const r = c.getBoundingClientRect();
    const v = tlView();
    const ct = v.start + Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * v.len;
    const yPx = e.clientY - r.top;
    const lane = laneAt(yPx);
    const ins = lane >= 0 ? insertAtComp(ct, lane) : null;
    ctxTarget = { t: ct, ins, lane };  // t = TIMELINE position
    $('ctxRecordInsert').classList.toggle('hidden', !!ins);
    $('ctxFileInsert').classList.toggle('hidden', !!ins);
    $('ctxOpenInsert').classList.toggle('hidden', !ins || ins.kind === 'music');
    $('ctxDuplicateInsert').classList.toggle('hidden', !ins);
    $('ctxRemoveInsert').classList.toggle('hidden', !ins);
    $('ctxMusicVol').classList.toggle('hidden', !(ins && ins.kind === 'music'));
    $('ctxMusicLoop').classList.toggle('hidden', !(ins && ins.kind === 'music'));
    if (ins && ins.kind === 'music') {
      $('ctxMusicVol').textContent = `🎚 Music volume… (${Math.round(musicVol(ins) * 100)}%)`;
      $('ctxMusicLoop').textContent = ins.loop ? '🔁 Un-loop (one play-through)' : '🔁 Loop to fill timeline';
      $('ctxRemoveInsert').textContent = '✕ Remove music';
    } else {
      $('ctxRemoveInsert').textContent = '✕ Remove insert';
    }
    const locHere = locate(ct);
    const locSeg = locHere.type === 'base' ? segForSource(locHere.t) : null;
    ctxTarget.camSeg = locSeg && locSeg.cam ? locSeg : null;
    // delete-a-piece: only on the main track, on a piece, when it's been split
    const piece = (lane < 0 && !ins) ? segAtTimeline(ct) : null;
    ctxTarget.seg = piece && segs().length > 1 ? piece : null;
    $('ctxDeleteSeg').classList.toggle('hidden', !ctxTarget.seg);
    if (ctxTarget.seg) $('ctxDeleteSeg').textContent =
      `🗑 Delete this piece (${fmtSec(segLen(ctxTarget.seg))})`;
    $('ctxRemoveCamKf').classList.toggle('hidden', !ctxTarget.camSeg);
    $('ctxClearCamKf').classList.toggle('hidden', !segs().some(sg => sg.cam));
    $('ctxAddTrack').classList.toggle('hidden', !!ins);
    $('ctxRemoveTrack').classList.toggle('hidden', !!ins || lane < 0 || tlTracks().length <= 1);
    if (lane >= 0 && !ins) $('ctxRemoveTrack').textContent = `➖ Remove “${tlTracks()[lane].name}”`;
    placeMenu($('tlContext'), e.clientX, e.clientY);
  });
  document.addEventListener('click', e => {
    $('tlContext').classList.add('hidden');
    // dismiss the "add from another edit" picker when clicking outside it
    if (!$('editPicker').contains(e.target)) $('editPicker').classList.add('hidden');
  });
}

$('ctxRecordInsert').onclick = () => {
  window.open(`/?insertFor=${encodeURIComponent(sessionId)}&at=${ctxTarget.t.toFixed(3)}`, '_blank');
  tlToast('⏺ Recorder opened in a new tab — when you stop, the recording attaches here automatically. Reload this page after.');
};

$('ctxFileInsert').onclick = () => { $('insertFile').click(); };

$('ctxFromEdit').onclick = async e => {
  e.stopPropagation();
  const target = { t: ctxTarget.t, lane: Math.max(0, ctxTarget.lane) };
  const sessions = (await (await fetch('/api/sessions')).json())
    // any OTHER session with playable material — including raw recordings
    // that haven't been composited yet (we build the composite on add) and
    // asset-only sessions (transparent overlays, stock clips)
    .filter(s => s.id !== sessionId && (s.hasClean || s.hasComposite || s.hasRaw
      || s.files.some(f => /^asset-[\w-]+\.(mp4|webm)$/.test(f))));
  const picker = $('editPicker');
  if (!sessions.length) { tlToast('no other recordings or edits found yet'); return; }
  picker.innerHTML = sessions.map(s => {
    const btns = [];
    // prefer the name you gave the render (Renders page) over the raw folder id
    const rn = s.renderNames || {};
    const nameFor = (file, suffix) => `${esc(rn[file] || s.title)} — ${suffix}`;
    if (s.hasClean) btns.push(`<button class="mi" data-id="${esc(s.id)}" data-file="clean.mp4">✓ ${nameFor('clean.mp4', 'clean edit')}</button>`);
    if (s.hasComposite) btns.push(`<button class="mi" data-id="${esc(s.id)}" data-file="composite.mp4">${nameFor('composite.mp4', 'full recording')}</button>`);
    // raw recording, not composited yet: build it when picked
    if (!s.hasComposite && !s.hasClean && s.hasRaw)
      btns.push(`<button class="mi" data-id="${esc(s.id)}" data-file="composite.mp4" data-build="1">${esc(s.title)} — recording (prepares on add)</button>`);
    for (const f of s.files.filter(x => /^asset-[\w-]+\.(mp4|webm)$/.test(x))) {
      const nice = f.replace(/^asset-/, '').replace(/\.(mp4|webm)$/, '').replace(/-/g, ' ');
      btns.push(`<button class="mi" data-id="${esc(s.id)}" data-file="${esc(f)}">🎞 ${esc(nice)}${f.endsWith('.webm') ? ' (transparent)' : ''}</button>`);
    }
    return btns.join('');
  }).join('');
  const menu = $('tlContext').getBoundingClientRect();
  // show at most 7 rows, then scroll — a long list must never run off-screen.
  // measure the real (uncapped) row layout first, then cap to the 7th row's
  // bottom (+6px for the menu's bottom padding & border, box-sizing: border-box)
  picker.style.overflow = 'auto';
  picker.style.maxHeight = '';
  picker.classList.remove('hidden');
  if (picker.parentElement !== document.body) document.body.appendChild(picker);
  picker.style.position = 'fixed';
  const rows = picker.querySelectorAll('.mi');
  if (rows.length > 7) {
    const seventh = rows[6];
    picker.style.maxHeight = (seventh.offsetTop + seventh.offsetHeight + 6) + 'px';
  }
  placeMenu(picker, menu.left + 40, menu.top);
  picker.querySelectorAll('.mi').forEach(btn => btn.onclick = async () => {
    picker.classList.add('hidden');
    const fromId = btn.dataset.id, fromFile = btn.dataset.file;
    // raw recording: composite it first (build in that session), then add
    if (btn.dataset.build) {
      tlToast(`preparing “${btn.textContent.trim()}”… (compositing its recording)`);
      await fetch(`/api/composite?session=${encodeURIComponent(fromId)}`, { method: 'POST' });
      let misses = 0;
      for (;;) {
        await new Promise(r => setTimeout(r, 1500));
        let j;
        try {
          j = await (await fetch(`/api/job?session=${encodeURIComponent(fromId)}`)).json();
          misses = 0;
        } catch {
          if (++misses >= 5) { tlToast('lost contact with the server'); return; }
          continue;
        }
        if (j.status !== 'running') {
          if (j.status !== 'done') { tlToast('couldn’t prepare that recording — see its own tab'); return; }
          break;
        }
      }
    }
    const url = `/recordings/${encodeURIComponent(fromId)}/${encodeURIComponent(fromFile)}`;
    const dur = await new Promise(res => {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.onloadedmetadata = () => res(isFinite(v.duration) ? v.duration : 0);
      v.onerror = () => res(0);
      v.src = url;
    });
    tr.inserts = tr.inserts || [];
    tr.inserts.push({
      id: `ins-${Date.now().toString(36)}`, at: Math.round(target.t * 10) / 10,
      fromSession: fromId, fromFile, kind: 'video',
      duration: Math.round(dur * 100) / 100,
      label: btn.textContent.trim().replace(' — recording (prepares on add)', ''),
      track: tlTracks()[target.lane].id,
    });
    markDirty(); await saveTranscript(); updateStats();
    tlToast(`📼 added at ${fmtSec(target.t)}`);
  });
};

function mediaDuration(file) {
  return new Promise(resolve => {
    const el = document.createElement(file.type.startsWith('audio') ? 'audio' : 'video');
    el.preload = 'metadata';
    el.onloadedmetadata = () => { const d = el.duration; URL.revokeObjectURL(el.src); resolve(isFinite(d) ? d : 0); };
    el.onerror = () => resolve(0);
    el.src = URL.createObjectURL(file);
  });
}

$('insertFile').onchange = async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const dur = await mediaDuration(file);
  const ext = (file.name.split('.').pop() || 'mp4').toLowerCase().replace(/[^\w]/g, '');
  const name = `insert-${Date.now().toString(36)}.${ext}`;
  await fetch(`/api/upload?session=${sessionId}&name=${name}`, { method: 'POST', body: file });
  tr.inserts = tr.inserts || [];
  tr.inserts.push({
    id: `ins-${Date.now().toString(36)}`, at: Math.round(ctxTarget.t * 1000) / 1000,
    file: name, kind: file.type.startsWith('audio') ? 'audio' : 'video',
    duration: Math.round(dur * 100) / 100, label: file.name,
    track: tlTracks()[Math.max(0, ctxTarget.lane)].id,
  });
  markDirty(); await saveTranscript();
  updateStats();
  tlToast(`🎞 “${file.name}” inserted at ${fmtSec(ctxTarget.t)} — it will be spliced in at render`);
};

$('ctxOpenInsert').onclick = () => {
  const ins = ctxTarget.ins;
  if (!ins) return;
  const url = ins.fromSession
    ? `/recordings/${encodeURIComponent(ins.fromSession)}/composite.mp4`
    : `/recordings/${sessionId}/${encodeURIComponent(ins.file)}`;
  window.open(url, '_blank');
};

$('ctxDuplicateInsert').onclick = async () => {
  const src = ctxTarget.ins;
  if (!src) return;
  // faithful copy — same source, framing, trims, cuts, volume — new id, dropped
  // right after the original on the SAME track (clips may overlap; they stack)
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = `ins-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  copy.track = src.track;
  copy.at = Math.round((src.at + effDur(src)) * 100) / 100;
  tr.inserts = tr.inserts || [];
  tr.inserts.push(copy);
  markDirty(); tl.static = null; await saveTranscript(); updateStats();
  tlToast(`⧉ duplicated “${src.label || 'clip'}” at ${fmtSec(copy.at)} — drag it anywhere`);
};

$('ctxRemoveInsert').onclick = async () => {
  if (!ctxTarget.ins) return;
  tr.inserts = (tr.inserts || []).filter(i => i.id !== ctxTarget.ins.id);
  markDirty(); await saveTranscript();
  updateStats();
  tlToast('insert removed');
};

$('ctxDeleteSeg').onclick = async () => {
  if (!ctxTarget.seg) return;
  tr.segments = segs();
  const real = tr.segments.find(x => x.id === ctxTarget.seg.id);
  if (!real || tr.segments.length <= 1) return;
  const len = segLen(real), p1 = real.pos + len;
  tr.segments = tr.segments.filter(x => x.id !== real.id);
  // ripple: close the hole the piece leaves behind
  for (const sg of tr.segments) if (sg.pos >= p1 - 1e-6) sg.pos = Math.round((sg.pos - len) * 1000) / 1000;
  for (const ins of (tr.inserts || [])) if (ins.at >= p1 - 1e-6) ins.at = Math.round((ins.at - len) * 100) / 100;
  syncWordsToArrangement();
  markDirty(); renderTranscript(); updateStats(); tl.static = null;
  await saveTranscript();
  tlToast(`🗑 piece deleted (${fmtSec(len)}) — ⌘Z to undo`);
};

$('ctxMusicVol').onclick = async () => {
  const ins = ctxTarget.ins;
  if (!ins || ins.kind !== 'music') return;
  const cur = Math.round(musicVol(ins) * 100);
  const v = prompt('Music volume % (5–100):', cur);
  if (v === null) return;
  const pct = Math.max(5, Math.min(100, parseFloat(v) || cur));
  ins.volume = pct / 100;
  delete ins.gain;   // % replaces the legacy dB field
  markDirty(); await saveTranscript();
  tlToast(`🎚 “${ins.label || 'music'}” at ${pct}% volume`);
};

$('ctxMusicLoop').onclick = async () => {
  const ins = ctxTarget.ins;
  if (!ins || ins.kind !== 'music') return;
  // timeline end WITHOUT this clip, so a long music clip can't hold it open
  const end = Math.max(
    ...segs().map(sg => sg.pos + segLen(sg)),
    ...(tr.inserts || []).filter(i => i.id !== ins.id).map(i => i.at + effDur(i)),
    ins.at + 1);
  if (ins.loop) {
    ins.loop = false;
    const td = await audioDuration(insertUrl(ins));
    ins.duration = Math.round(Math.min(td || ins.duration, Math.max(1, end - ins.at)) * 100) / 100;
    ins.label = (ins.label || '🎵 music').replace(' 🔁', '');
    tlToast('🔁 loop off — one play-through');
  } else {
    ins.loop = true;
    ins.duration = Math.round(Math.max(1, end - ins.at) * 100) / 100;  // fallback for older renders
    ins.label = (ins.label || '🎵 music').replace(' 🔁', '') + ' 🔁';
    tlToast('🔁 looping — the clip now follows the end of the timeline as your edit changes');
  }
  markDirty(); await saveTranscript(); updateStats(); tl.static = null;
};

$('ctxRemoveCamKf').onclick = async () => {
  if (!ctxTarget.camSeg) return;
  const real = (tr.segments || []).find(x => x.id === ctxTarget.camSeg.id);
  if (real) delete real.cam;
  appliedCamSig = '';
  markDirty(); await saveTranscript();
  tl.static = null;
  tlToast('📷 this piece uses the recorded bubble position again');
};

$('ctxClearCamKf').onclick = async () => {
  for (const sg of (tr.segments || [])) delete sg.cam;
  appliedCamSig = '';
  markDirty(); await saveTranscript();
  tl.static = null;
  tlToast('📷 webcam bubble back to its recorded position throughout');
};

$('ctxAddTrack').onclick = async () => {
  const tracks = tlTracks();
  tracks.push({ id: `t${Date.now().toString(36)}`, name: `Track ${tracks.length + 1}` });
  markDirty(); await saveTranscript();
  if (tl.resize) tl.resize();
  tlToast(`➕ “${tracks[tracks.length - 1].name}” added — right-click on it to put clips there`);
};

$('ctxRemoveTrack').onclick = async () => {
  const tracks = tlTracks();
  if (ctxTarget.lane < 0 || tracks.length <= 1) return;
  const removed = tracks.splice(ctxTarget.lane, 1)[0];
  // clips on the removed timeline slide down to the first one
  const valid = new Set(tracks.map(t => t.id));
  (tr.inserts || []).forEach(i => { if (!valid.has(i.track)) i.track = tracks[0].id; });
  markDirty(); await saveTranscript();
  if (tl.resize) tl.resize();
  tlToast(`➖ “${removed.name}” removed — its clips moved to “${tracks[0].name}”`);
};

function tlRedrawStatic() {
  const c = $('timeline');
  if (!tr || !c.width) return;
  const dur = tlDur();
  if (!dur) return;
  const off = tl.static = (tl.static && tl.static.width === c.width && tl.static.height === c.height)
    ? tl.static
    : Object.assign(document.createElement('canvas'), { width: c.width, height: c.height });
  const g = off.getContext('2d');
  const W = off.width, H = off.height;
  const v = tlView();
  const x = t => (t - v.start) / v.len * W;          // t is TIMELINE position
  const visible = (a, b) => b >= v.start && a <= v.start + v.len;
  const dpr = devicePixelRatio || 1;
  g.fillStyle = '#0a0a0c'; g.fillRect(0, 0, W, H);

  // overlay timelines (top lanes)
  const { lanes, total } = laneMetrics();
  const tracks = tlTracks();
  tracks.forEach((tk, li) => {
    const y = lanes[li].y * dpr, h = (lanes[li].h - 2) * dpr;
    const selected = tl.selectedLane === li;
    g.fillStyle = selected ? 'rgba(10,132,255,.10)'
      : li === tl.expandedLane ? 'rgba(255,255,255,.06)' : 'rgba(255,255,255,.03)';
    g.fillRect(0, y, W, h);
    if (lanes[li].h >= 12) {
      g.fillStyle = selected ? 'rgba(10,132,255,.9)' : 'rgba(255,255,255,.30)';
      g.font = `${selected ? '600 ' : ''}${9 * dpr}px -apple-system, sans-serif`;
      g.fillText(tk.name + (selected ? ' · cutting here' : ''), 5 * dpr, y + h - 3 * dpr);
    }
    for (const ins of (tr.inserts || [])) {
      if (trackIndex(ins) !== li) continue;
      const a = ins.at, b = ins.at + Math.max(0.5, effDur(ins));
      if (!visible(a, b)) continue;
      g.fillStyle = tl.insDrag && tl.insDrag.ins.id === ins.id
        ? 'rgba(191,90,242,1)'
        : selected ? 'rgba(10,132,255,.9)' : 'rgba(191,90,242,.85)';
      g.beginPath();
      g.roundRect(x(a), y, Math.max(6, x(b) - x(a)), h, 3 * dpr);
      g.fill();
      if (lanes[li].h >= 20) {
        g.fillStyle = 'rgba(255,255,255,.9)';
        g.font = `600 ${9 * dpr}px -apple-system, sans-serif`;
        g.save();
        g.beginPath(); g.rect(x(a), y, Math.max(6, x(b) - x(a)), h); g.clip();
        g.fillText(ins.label || 'insert', x(a) + 5 * dpr, y + h - 8 * dpr);
        g.restore();
      }
    }
  });

  // main track: footage segments (scissor pieces) with speech blocks inside
  const wy = (total + 2) * dpr;
  const wh = Math.max(8 * dpr, H - wy - 10 * dpr);
  const mainSel = tl.selectedLane === -1;
  for (const sg of segs()) {
    const a = sg.pos, b = sg.pos + segLen(sg);
    if (!visible(a, b)) continue;
    const dragged = tl.segDrag && tl.segDrag.sg.id === sg.id;
    g.fillStyle = dragged ? 'rgba(255,255,255,.14)' : 'rgba(255,255,255,.05)';
    g.beginPath(); g.roundRect(x(a), wy - 2 * dpr, x(b) - x(a), wh + 4 * dpr, 3 * dpr); g.fill();
    g.strokeStyle = 'rgba(255,255,255,.22)';
    g.strokeRect(x(a) + 0.5, wy - 2 * dpr + 0.5, x(b) - x(a) - 1, wh + 4 * dpr - 1);
  }
  const inSeg = t => segs().some(sg => t >= sg.s0 - 0.01 && t <= sg.s1 + 0.01);
  for (const w of tr.words) {
    if (!inSeg((w.start + w.end) / 2)) continue;   // source not placed anywhere
    const a = compOf(w.start), b = a + (w.end - w.start);
    if (!visible(a, b)) continue;
    g.fillStyle = w.removed ? '#63201b' : (w.detected ? '#8a5606'
      : mainSel ? '#0a84ff' : '#7d4bb5');
    g.fillRect(x(a), wy, Math.max(1, x(b) - x(a)), wh);
  }
  // manual range cuts
  for (const [ra, rb] of (tr.cutRanges || [])) {
    if (!inSeg((ra + rb) / 2)) continue;
    const a = compOf(ra), b = a + (rb - ra);
    if (!visible(a, b)) continue;
    g.fillStyle = 'rgba(255,69,58,.32)';
    g.fillRect(x(a), wy, x(b) - x(a), H - wy);
    g.strokeStyle = '#ff453a'; g.strokeRect(x(a) + 0.5, wy + 0.5, x(b) - x(a) - 1, H - wy - 1);
  }
  // keep material as a green baseline, clipped to placed segments; overlays purple
  g.fillStyle = '#30d158';
  for (const sg of segs()) {
    for (const [ka, kb] of keepSegments()) {
      const ia = Math.max(ka, sg.s0), ib = Math.min(kb, sg.s1);
      if (ib - ia < 0.05) continue;
      const a = compOf(ia), b = a + (ib - ia);
      if (visible(a, b)) g.fillRect(x(a), H - 5, Math.max(1, x(b) - x(a)), 4);
    }
  }
  g.fillStyle = '#bf5af2';
  for (const ins of (tr.inserts || [])) {
    const a = ins.at, b = ins.at + effDur(ins);
    if (visible(a, b)) g.fillRect(x(a), H - 5, Math.max(1, x(b) - x(a)), 4);
  }
  // cut seams: dashed markers where material was cut or split
  const seamY0 = wy - 4 * dpr, seamY1 = H - 6 * dpr;
  g.strokeStyle = 'rgba(255,255,255,.55)';
  g.setLineDash([3 * dpr, 3 * dpr]);
  g.lineWidth = 1;
  const seam = (t) => {
    if (t < v.start || t > v.start + v.len) return;
    g.beginPath(); g.moveTo(x(t), seamY0); g.lineTo(x(t), seamY1); g.stroke();
  };
  for (const [ra, rb] of (tr.cutRanges || [])) {
    if (inSeg(ra)) seam(compOf(ra));
    if (inSeg(rb)) seam(compOf(rb));
  }
  const sorted = segs();
  for (let k = 1; k < sorted.length; k++) {
    if (Math.abs(sorted[k].pos - (sorted[k - 1].pos + segLen(sorted[k - 1]))) < 0.05) {
      seam(sorted[k].pos);   // adjacent scissor junction
    }
  }
  g.setLineDash([]);

  // pieces with their own bubble placement get a cyan corner tag
  g.fillStyle = '#64d2ff';
  for (const sg of segs()) {
    if (!sg.cam) continue;
    const cx = x(sg.pos);
    if (cx < -10 || cx > W + 10) continue;
    g.beginPath();
    g.moveTo(cx, wy); g.lineTo(cx + 7 * dpr, wy); g.lineTo(cx, wy + 7 * dpr);
    g.closePath(); g.fill();
  }

  // second ticks when zoomed in close
  if (v.len <= 90) {
    g.fillStyle = 'rgba(255,255,255,.25)';
    const step = v.len <= 20 ? 1 : 5;
    for (let t = Math.ceil(v.start / step) * step; t <= v.start + v.len; t += step) {
      g.fillRect(x(t), wy, 1, H * 0.15);
    }
  }
}

function tlFrame() {
  const c = $('timeline');
  if (!tr || !c.width) return;
  const dur = tlDur();
  if (!dur) return;
  if (!tl.static || tl.static.width !== c.width) tlRedrawStatic();
  const g = c.getContext('2d');
  const W = c.width, H = c.height;
  overlaySync();
  checkArrangement();
  refreshCamPlacement();
  const t = curTimelineTime();
  const playing = gap ? !gap.paused : !$('player').paused;
  // auto-follow the playhead when zoomed in and playing
  const v0 = tlView();
  if (tl.view && playing && (t < v0.start || t > v0.start + v0.len)) {
    tlSetView(t - v0.len * 0.1, v0.len);
  }
  const v = tlView();
  const x = tt => (tt - v.start) / v.len * W;
  g.clearRect(0, 0, W, H);
  if (tl.static) g.drawImage(tl.static, 0, 0);
  // drag selection — only over the selected timeline's row
  if (tl.sel) {
    const [a, b] = tl.sel;
    const dpr = devicePixelRatio || 1;
    const { lanes, total } = laneMetrics();
    let selY = 0, selH = H;
    if (tl.selectedLane >= 0 && lanes[tl.selectedLane]) {
      selY = lanes[tl.selectedLane].y * dpr;
      selH = (lanes[tl.selectedLane].h - 2) * dpr;
    } else {
      selY = (total + 0) * dpr;
      selH = H - selY;
    }
    g.fillStyle = 'rgba(255,214,10,.26)';
    g.fillRect(x(a), selY, x(b) - x(a), selH);
  }
  // snap guide (while dragging a block to a clip edge or word boundary)
  if (tl.snapAt != null && tl.snapAt >= v.start && tl.snapAt <= v.start + v.len) {
    g.fillStyle = '#30d158';
    g.fillRect(x(tl.snapAt) - 0.5, 0, 1, H);
  }
  // playhead
  if (t >= v.start && t <= v.start + v.len) {
    g.fillStyle = activeOverlay ? '#bf5af2' : '#fff';
    g.fillRect(x(t) - 1, 0, 2, H);
  }
  $('tlTime').textContent = `${fmtSec(t)} / ${fmtSec(dur)}`;
}

// ---------- drag-highlight words to cut a whole sentence ----------
let dragAnchor = null, dragLast = null, dragJustCut = false;

function applyDragSel() {
  document.querySelectorAll('.word.drag-sel').forEach(e => e.classList.remove('drag-sel'));
  let a, b;
  if (dragAnchor !== null && dragLast !== null && dragAnchor !== dragLast) {
    [a, b] = [Math.min(dragAnchor, dragLast), Math.max(dragAnchor, dragLast)];
  } else if (typeof txSel !== 'undefined' && txSel) {
    [a, b] = txSel;
  } else return;
  for (let k = a; k <= b; k++) {
    const el = document.querySelector(`.word[data-i="${k}"]`);
    if (el) el.classList.add('drag-sel');
  }
}

let txSel = null; // [firstWordIdx, lastWordIdx] — persistent transcript selection

window.addEventListener('pointerup', () => {
  if (dragAnchor !== null && dragLast !== null && dragAnchor !== dragLast) {
    txSel = [Math.min(dragAnchor, dragLast), Math.max(dragAnchor, dragLast)];
    dragJustCut = true;                     // suppress the click, keep the highlight
    setTimeout(() => dragJustCut = false, 0);
    applyDragSel();
  }
  dragAnchor = dragLast = null;
});

function txSelTimes() {
  if (!txSel) return null;
  const pad = tr.settings.padSec || 0.12;
  return [Math.max(0, tr.words[txSel[0]].start - pad), tr.words[txSel[1]].end + pad];
}

$('transcript').addEventListener('contextmenu', e => {
  if (!txSel) return;
  e.preventDefault();
  placeMenu($('txContext'), e.clientX, e.clientY);
});
document.addEventListener('click', () => $('txContext').classList.add('hidden'));

function txSetRemoved(flag) {
  if (!txSel) return;
  for (let k = txSel[0]; k <= txSel[1]; k++) {
    tr.words[k].removed = flag;
    tr.words[k].reason = flag ? 'manual' : null;
  }
  markDirty(); renderTranscript(); updateStats();
  txSel = null;
}
$('txCut').onclick = () => txSetRemoved(true);
$('txRestore').onclick = () => txSetRemoved(false);

$('txNewSession').onclick = async () => {
  const range = txSelTimes();
  if (!range) return;
  $('txContext').classList.add('hidden');
  tlToast('creating a new edit session from the selection…');
  const j = await runJob('subsession', `&start=${range[0].toFixed(2)}&end=${range[1].toFixed(2)}`);
  if (j.status === 'done') {
    const m = (j.tail || '').match(/subsession ready: (\S+)/);
    if (m) window.open(`editor.html?session=${encodeURIComponent(m[1])}`, '_blank');
  }
  txSel = null; renderTranscript();
};

$('txRenderPart').onclick = async () => {
  const range = txSelTimes();
  if (!range) return;
  $('txContext').classList.add('hidden');
  await saveTranscript();
  const j = await runJob('render', `&quality=${$('renderQuality').value}&format=wide` +
    ($('renderCompress').checked ? '&compress=1' : '') +
    `&rstart=${range[0].toFixed(2)}&rend=${range[1].toFixed(2)}`);
  if (j.status === 'done') {
    $('dlClean').classList.remove('hidden');
    $('dlClean').href = `/recordings/${sessionId}/clean-part.mp4?t=${Date.now()}`;
    $('dlClean').textContent = `Download selection render`;
    $('dlClean').download = `${sessName.replace(/[^\w.-]+/g, '-')}-part.mp4`;
  }
  txSel = null; renderTranscript();
};

// copy transcript text to the clipboard
$('copyTranscriptBtn').onclick = async () => {
  const keptOnly = $('copyKeptOnly').checked;
  const text = tr.words
    .filter(w => !w.detected && (!keptOnly || !w.removed))
    .map(w => w.w).join(' ')
    .replace(/([.!?])\s/g, '$1\n\n'); // paragraph break after each sentence group
  await navigator.clipboard.writeText(text);
  const btn = $('copyTranscriptBtn');
  btn.textContent = '✔ Copied';
  setTimeout(() => btn.textContent = '📋 Copy transcript', 2000);
};

// ---------- overlay + arrangement playback engine ----------
// Overlays play ON TOP of the footage under them; the main player never
// pauses for them. Gaps in the arrangement run on a virtual clock so the
// playhead keeps moving through empty timeline.
let activeOverlay = null;
let gap = null;          // {tlPos0, started, untilTl, next}
let lastMainT = 0;

function insertUrl(ins) {
  if (ins.musicTrack) return `/music/${encodeURIComponent(ins.musicTrack)}`;
  return ins.fromSession
    ? `/recordings/${encodeURIComponent(ins.fromSession)}/${encodeURIComponent(ins.fromFile || 'composite.mp4')}`
    : `/recordings/${sessionId}/${encodeURIComponent(ins.file)}`;
}

function curTimelineTime() {
  if (gap) {
    const run = gap.paused ? (gap.frozen || 0) : (performance.now() - gap.started) / 1000;
    return Math.min(gap.untilTl, gap.tlPos0 + run);
  }
  return compOf($('player').currentTime || 0);
}

// park the playhead at ANY timeline position (footage, gap, or under a clip)
function seekTimeline(c) {
  c = Math.max(0, c);
  gap = null;
  $('gapCover').classList.add('hidden');
  const loc = locate(c);
  if (loc.type === 'base') {
    $('player').currentTime = loc.t;
  } else {
    $('player').pause();
    const nxt = loc.next;
    gap = { tlPos0: c, started: performance.now(), frozen: 0, paused: true,
            untilTl: nxt ? nxt.pos : tlEnd(), next: nxt };
    $('gapCover').classList.remove('hidden');
  }
  overlaySync();
}

// Every overlay covering the playhead is drawn as its own stacked <video>, so a
// clip on an upper track that is framed smaller — or transparent — reveals the
// footage (or lower overlays) beneath it, exactly like the final render. The
// TOPMOST overlay owns #insertPlayer and stays editable; the rest are display-
// only elements pooled by id in subOverlays. Higher tracks get higher z-index.
const subOverlays = new Map();   // insert id -> <video> (overlays below the top)

function overlaySync() {
  if (!tr) return;
  const c = curTimelineTime();
  const list = overlaysAt(c);            // top-first (lower track index = on top)
  const top = list[0] || null;
  const N = list.length;
  const mainPlaying = gap ? !gap.paused : !$('player').paused;
  const ip = $('insertPlayer');

  // ---- topmost overlay: editable, on #insertPlayer ----
  if ((top && top.id) !== (activeOverlay && activeOverlay.id)) {
    activeOverlay = top;
    if (top) {
      ip.src = insertUrl(top);
      ip.classList.toggle('alpha', isAlphaIns(top));
      ip.classList.remove('hidden');
      ip.classList.add('editable');
      placeInsertFrame(top);
      $('insertBadge').classList.remove('hidden');
      $('insertBadge').textContent = `▶ ${top.label || 'insert'}`;
    } else {
      ip.pause();
      ip.classList.add('hidden');
      ip.removeAttribute('src');
      $('insertBadge').classList.add('hidden');
    }
  }
  if (top) {
    ip.style.zIndex = 6 + N;               // set AFTER placeInsertFrame (cssText wipes it)
    const want = (top.srcStart || 0) + rawOfEff(top, c - top.at);
    if (ip.readyState >= 1 && Math.abs(ip.currentTime - want) > 0.4) ip.currentTime = want;
    if (mainPlaying && ip.paused) ip.play().catch(() => {});
    if (!mainPlaying && !ip.paused) ip.pause();
  }

  // ---- overlays beneath the top: display-only, stacked in track order ----
  const subs = list.slice(1);
  const alive = new Set(subs.map(s => s.id));
  for (const [id, el] of subOverlays) {
    if (!alive.has(id)) { el.pause(); el.remove(); subOverlays.delete(id); }
  }
  subs.forEach((ov, j) => {
    let el = subOverlays.get(ov.id);
    if (!el) {
      el = document.createElement('video');
      el.className = 'insert-player sub';
      el.playsInline = true;
      el.muted = true;                     // preview: the top overlay carries audio
      el.src = insertUrl(ov);
      el.classList.toggle('alpha', isAlphaIns(ov));
      el.addEventListener('loadedmetadata', () => { if (el._ov) placeInsertFrame(el._ov, el); });
      el.addEventListener('timeupdate', () => {
        if (!el._ov || el.paused) return;
        const t = el.currentTime;
        for (const [a, b] of insCuts(el._ov)) if (t >= a - 0.05 && t < b) { el.currentTime = b; return; }
      });
      $('playerStage').appendChild(el);
      subOverlays.set(ov.id, el);
    }
    el._ov = ov;
    placeInsertFrame(ov, el);
    el.style.zIndex = 6 + N - j - 1;       // just under the sub above it; top is 6+N
    const want = (ov.srcStart || 0) + rawOfEff(ov, c - ov.at);
    if (el.readyState >= 1 && Math.abs(el.currentTime - want) > 0.4) el.currentTime = want;
    if (mainPlaying && el.paused) el.play().catch(() => {});
    if (!mainPlaying && !el.paused) el.pause();
  });

  syncMusicAudio(c);
}

// live music-bed preview: a hidden audio element follows the playhead through
// any 🎵 clip (no ducking in preview — that happens at render)
const musicBed = { el: new Audio(), id: null };
function syncMusicAudio(c) {
  const playing = gap ? !gap.paused : !$('player').paused;
  const m = (tr.inserts || []).find(i =>
    i.kind === 'music' && c >= i.at && c < i.at + effDur(i));
  const el = musicBed.el;
  if (!m || !playing) {
    if (!el.paused) el.pause();
    if (!m) musicBed.id = null;
    return;
  }
  if (musicBed.id !== m.id) {
    musicBed.id = m.id;
    el.src = insertUrl(m);
  }
  // read every frame so a right-click volume change applies instantly;
  // preview plays at the TRUE clip level (render adds ducking on top)
  el.volume = Math.max(0.02, Math.min(1, musicVol(m)));
  el.loop = !!m.loop;
  let want = (m.srcStart || 0) + (c - m.at);
  if (m.loop && el.duration && isFinite(el.duration)) want %= el.duration;
  if (el.readyState >= 1 && Math.abs(el.currentTime - want) > 0.4) el.currentTime = want;
  if (el.paused) el.play().catch(() => {});
}

// keep the playhead moving across segment ends and through gaps
function checkArrangement() {
  const p = $('player');
  if (gap) {
    if (gap.paused) return;   // parked in the gap
    if (curTimelineTime() >= gap.untilTl - 0.03) {
      const nxt = gap.next;
      gap = null;
      $('gapCover').classList.add('hidden');
      if (nxt) { p.currentTime = nxt.s0 + 0.001; p.play().catch(() => {}); }
      else p.pause();
    }
    return;
  }
  if (p.paused) return;
  const t = p.currentTime;
  const sg = segs().find(x => t >= x.s0 - 0.05 && t <= x.s1 + 0.08);
  if (!sg) return;
  if (t >= sg.s1 - 0.05) {
    const c = sg.pos + segLen(sg);
    const nxt = segs().filter(x => x.id !== sg.id && x.pos >= c - 0.05)
      .sort((a, b) => a.pos - b.pos)[0] || null;
    if (nxt && nxt.pos <= c + 0.05) {
      p.currentTime = nxt.s0 + 0.001;                 // adjacent piece: jump straight in
    } else if (nxt || overlayAt(c + 0.1)) {
      p.pause();                                       // gap: run the virtual clock
      gap = { tlPos0: c, started: performance.now(),
              untilTl: nxt ? nxt.pos : tlEnd(), next: nxt };
      $('gapCover').classList.remove('hidden');
    } else {
      p.pause();                                       // true end of arrangement
    }
  }
}

// skip an overlay's own cut ranges while it plays
$('insertPlayer').addEventListener('timeupdate', () => {
  const ip = $('insertPlayer');
  if (!activeOverlay || ip.paused) return;
  const t = ip.currentTime;
  for (const [a, b] of insCuts(activeOverlay)) {
    if (t >= a - 0.05 && t < b) { ip.currentTime = b; return; }
  }
});

// ---------- webcam bubble editing: drag to move, any edge/corner to resize;
// adjusting writes a keyframe at the playhead so different cuts can have
// different placements ----------
const camEdit = { act: null };
(() => {
  const EDGE = 10;
  const CURSORS = {
    nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
    n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', move: 'grab',
  };
  const box = $('camOverlay');

  function videoRect() {
    const player = $('player');
    const stage = $('playerStage').getBoundingClientRect();
    const rect = player.getBoundingClientRect();
    let vx = rect.left, vy = rect.top, vw = rect.width, vh = rect.height;
    if (player.videoWidth) {
      const scale = Math.min(rect.width / player.videoWidth, rect.height / player.videoHeight);
      vw = player.videoWidth * scale;
      vh = player.videoHeight * scale;
      vx += (rect.width - vw) / 2;
      vy += (rect.height - vh) / 2;
    }
    return { vx, vy, vw, vh };
  }

  function zoneFor(e) {
    const b = box.getBoundingClientRect();
    const lx = e.clientX - b.left, ly = e.clientY - b.top;
    const L = lx < EDGE, R = lx > b.width - EDGE;
    const T = ly < EDGE, B = ly > b.height - EDGE;
    if (T && L) return 'nw';
    if (T && R) return 'ne';
    if (B && L) return 'sw';
    if (B && R) return 'se';
    if (T) return 'n';
    if (B) return 's';
    if (L) return 'w';
    if (R) return 'e';
    return 'move';
  }

  box.addEventListener('pointermove', e => {
    if (!camEdit.act && box.classList.contains('editable')) box.style.cursor = CURSORS[zoneFor(e)];
  });

  box.addEventListener('pointerdown', e => {
    if (!box.classList.contains('editable')) return;
    const eff = layoutAt($('player').currentTime || 0);
    const r = videoRect();
    const hN = (eff.w * r.vw / (eff.aspect || 1)) / r.vh;
    camEdit.act = { z: zoneFor(e), sx: e.clientX, sy: e.clientY, s: { ...eff, hN }, work: { ...eff } };
    e.preventDefault(); e.stopPropagation();
  });

  window.addEventListener('pointermove', e => {
    const a = camEdit.act;
    if (!a) return;
    const r = videoRect();
    const dx = (e.clientX - a.sx) / r.vw;
    const dy = (e.clientY - a.sy) / r.vh;
    const { z, s } = a;
    const w0 = a.work;
    if (z === 'move') {
      w0.x = Math.min(Math.max(s.x + dx, 0), 1 - s.w);
      w0.y = Math.min(Math.max(s.y + dy, 0), Math.max(0, 1 - s.hN));
    } else {
      const wFromX = z.includes('e') ? s.w + dx : z.includes('w') ? s.w - dx : null;
      const hDelta = z.includes('s') ? dy : z.includes('n') ? -dy : null;
      const wFromY = hDelta === null ? null
        : (s.hN + hDelta) * r.vh * (s.aspect || 1) / r.vw;
      let wN;
      if (wFromX !== null && wFromY !== null) {
        wN = Math.abs(wFromX - s.w) >= Math.abs(wFromY - s.w) ? wFromX : wFromY;
      } else {
        wN = wFromX !== null ? wFromX : wFromY;
      }
      wN = Math.min(Math.max(wN, 0.08), 0.6);
      w0.w = wN;
      const hN2 = (wN * r.vw / (s.aspect || 1)) / r.vh;
      if (z.includes('w')) w0.x = s.x + s.w - wN;
      if (z.includes('n')) w0.y = s.y + s.hN - hN2;
      w0.x = Math.min(Math.max(w0.x, 0), 1 - wN);
      w0.y = Math.min(Math.max(w0.y, 0), Math.max(0, 1 - hN2));
    }
    placeCamOverlay({ ...w0 });
  });

  window.addEventListener('pointerup', async () => {
    const a = camEdit.act;
    if (!a) return;
    camEdit.act = null;
    const { x, y, w } = a.work;
    if (Math.abs(x - a.s.x) < 0.003 && Math.abs(y - a.s.y) < 0.003 && Math.abs(w - a.s.w) < 0.003) return;
    // the placement belongs to the piece of footage under the playhead
    const t = $('player').currentTime || 0;
    const sg = materializedSeg(t);
    if (!sg) return;
    sg.cam = { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000,
               w: Math.round(w * 1000) / 1000 };
    appliedCamSig = '';
    markDirty(); await saveTranscript();
    tl.static = null;
    tlToast(`📷 webcam bubble set for this piece (${fmtSec(sg.pos)}–${fmtSec(sg.pos + segLen(sg))})`);
  });
})();

// ---------- framed overlay clips: drag/resize a clip in the preview to set
// where it sits over the footage (default = full frame) ----------
function stageVideoBox() {
  const player = $('player');
  const stage = $('playerStage').getBoundingClientRect();
  const rect = player.getBoundingClientRect();
  let vx = rect.left - stage.left, vy = rect.top - stage.top, vw = rect.width, vh = rect.height;
  if (player.videoWidth) {
    const sc = Math.min(rect.width / player.videoWidth, rect.height / player.videoHeight);
    vw = player.videoWidth * sc;
    vh = player.videoHeight * sc;
    vx += (rect.width - vw) / 2;
    vy += (rect.height - vh) / 2;
  }
  return { vx, vy, vw, vh };
}

// transparent overlay assets (VP9-alpha webm) get no plate, shadow, or corner
// rounding — the alpha IS the shape
function isAlphaIns(i) { return /\.webm$/i.test((i && (i.fromFile || i.file || i.musicTrack)) || ''); }

function placeInsertFrame(ov, ip = $('insertPlayer')) {
  if (!ov || !ov.frame) {
    ip.style.cssText = '';   // full frame (CSS default: inset 0)
    return;
  }
  const { vx, vy, vw, vh } = stageVideoBox();
  const f = ov.frame;
  const ar = (ip.videoWidth && ip.videoHeight) ? ip.videoWidth / ip.videoHeight : 16 / 9;
  const w = f.w * vw;
  const h = w / ar;
  // inset MUST come before left/top: it's a shorthand for top/right/bottom/left,
  // so writing it after silently resets both and the clip lands at its static
  // position outside the stage
  ip.style.cssText = `inset:auto; left:${vx + f.x * vw}px; top:${vy + f.y * vh}px;` +
    `width:${w}px; height:${h}px; object-fit:cover;` +
    (isAlphaIns(ov) ? 'background:transparent; box-shadow:none; border-radius:0;'
      : 'border-radius:8px; box-shadow:0 6px 24px rgba(0,0,0,.5);');
}
$('insertPlayer').addEventListener('loadedmetadata', () => {
  if (activeOverlay) placeInsertFrame(activeOverlay);
});

// same edge/corner editing as the bubble, writing ins.frame
const insFrameEdit = { act: null };
(() => {
  const EDGE = 10;
  const CURSORS = {
    nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
    n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', move: 'grab',
  };
  const ip = $('insertPlayer');

  function zoneFor(e) {
    const b = ip.getBoundingClientRect();
    const lx = e.clientX - b.left, ly = e.clientY - b.top;
    const L = lx < EDGE, R = lx > b.width - EDGE;
    const T = ly < EDGE, B = ly > b.height - EDGE;
    if (T && L) return 'nw';
    if (T && R) return 'ne';
    if (B && L) return 'sw';
    if (B && R) return 'se';
    if (T) return 'n';
    if (B) return 's';
    if (L) return 'w';
    if (R) return 'e';
    return 'move';
  }

  ip.addEventListener('pointermove', e => {
    if (!insFrameEdit.act) ip.style.cursor = CURSORS[zoneFor(e)];
  });

  ip.addEventListener('pointerdown', e => {
    if (!activeOverlay) return;
    const f = activeOverlay.frame || { x: 0, y: 0, w: 1 };
    const { vw, vh } = stageVideoBox();
    const ar = (ip.videoWidth && ip.videoHeight) ? ip.videoWidth / ip.videoHeight : 16 / 9;
    const hN = (f.w * vw / ar) / vh;
    insFrameEdit.act = { z: zoneFor(e), sx: e.clientX, sy: e.clientY, ar,
                         s: { ...f, hN }, work: { ...f }, ov: activeOverlay };
    e.preventDefault(); e.stopPropagation();
  });

  window.addEventListener('pointermove', e => {
    const a = insFrameEdit.act;
    if (!a) return;
    const { vw, vh } = stageVideoBox();
    const dx = (e.clientX - a.sx) / vw;
    const dy = (e.clientY - a.sy) / vh;
    const { z, s, ar } = a;
    const w0 = a.work;
    if (z === 'move') {
      w0.x = s.x + dx;
      w0.y = s.y + dy;
    } else {
      const wFromX = z.includes('e') ? s.w + dx : z.includes('w') ? s.w - dx : null;
      const hDelta = z.includes('s') ? dy : z.includes('n') ? -dy : null;
      const wFromY = hDelta === null ? null : (s.hN + hDelta) * vh * ar / vw;
      let wN;
      if (wFromX !== null && wFromY !== null) {
        wN = Math.abs(wFromX - s.w) >= Math.abs(wFromY - s.w) ? wFromX : wFromY;
      } else {
        wN = wFromX !== null ? wFromX : wFromY;
      }
      // like the webcam bubble: the clip lives fully INSIDE the stage.
      // Cap the width by whichever edges stay anchored during this resize.
      wN = Math.min(Math.max(wN, 0.08), 1);
      if (z.includes('w')) wN = Math.min(wN, s.x + s.w);            // right edge anchored
      else wN = Math.min(wN, 1 - s.x);                              // left edge anchored
      if (z.includes('n')) wN = Math.min(wN, ((s.y + s.hN) * vh * ar) / vw);  // bottom anchored
      else wN = Math.min(wN, ((1 - s.y) * vh * ar) / vw);           // top anchored
      wN = Math.max(wN, 0.08);
      const hN2 = (wN * vw / ar) / vh;
      if (z.includes('w')) w0.x = s.x + s.w - wN;
      if (z.includes('n')) w0.y = s.y + s.hN - hN2;
      w0.w = wN;
    }
    // final confinement, exactly like the bubble's clampLayout
    {
      const hN = (w0.w * vw / ar) / vh;
      w0.x = Math.min(Math.max(w0.x, 0), Math.max(0, 1 - w0.w));
      w0.y = Math.min(Math.max(w0.y, 0), Math.max(0, 1 - hN));
    }
    a.ov.frame = { x: w0.x, y: w0.y, w: w0.w };
    placeInsertFrame(a.ov);
  });

  window.addEventListener('pointerup', async () => {
    const a = insFrameEdit.act;
    if (!a) return;
    insFrameEdit.act = null;
    const f = a.work;
    if (Math.abs(f.x - a.s.x) < 0.003 && Math.abs(f.y - a.s.y) < 0.003 && Math.abs(f.w - a.s.w) < 0.003) return;
    // near-full-frame snaps back to full frame
    if (f.w > 0.97 && Math.abs(f.x) < 0.03 && Math.abs(f.y) < 0.03) delete a.ov.frame;
    else a.ov.frame = { x: Math.round(f.x * 1000) / 1000, y: Math.round(f.y * 1000) / 1000,
                        w: Math.round(f.w * 1000) / 1000 };
    placeInsertFrame(a.ov);
    markDirty(); await saveTranscript();
    tlToast(a.ov.frame
      ? `🎞 clip framed at ${Math.round((a.ov.frame.w) * 100)}% width — drag again to adjust`
      : '🎞 clip back to full frame');
  });
})();

// ⌘Z / ⇧⌘Z (or Ctrl on Windows/Linux) = undo / redo
window.addEventListener('keydown', e => {
  if (!tr || !(e.metaKey || e.ctrlKey) || e.altKey) return;
  const k = e.key.toLowerCase();
  const t = e.target;
  if (t && t.matches && t.matches('input, textarea, [contenteditable]')) return;
  if (k === 'z') { e.preventDefault(); histGo(e.shiftKey ? +1 : -1); }
  else if (k === 'y') { e.preventDefault(); histGo(+1); }
});

// spacebar toggles play/pause (unless typing in the search box etc.)
window.addEventListener('keydown', e => {
  if (e.code !== 'Space' || !tr) return;
  const t = e.target;
  if (t && t.matches && t.matches('input, textarea, select, button, [contenteditable]')) return;
  e.preventDefault(); // don't scroll the page
  if (gap) { // play/pause the virtual clock through the empty stretch
    if (gap.paused) {
      gap.started = performance.now() - (gap.frozen || 0) * 1000;
      gap.paused = false;
    } else {
      gap.frozen = (performance.now() - gap.started) / 1000;
      gap.paused = true;
    }
    return;
  }
  const p = $('player');
  p.paused ? p.play() : p.pause();
});

window.addEventListener('beforeunload', e => { if (dirty) e.preventDefault(); });

// ---------- boot ----------
if (sessionId) openSession(); else loadSessions();
