/* Screen Studio recorder — screen + webcam captured as SEPARATE files,
 * with a draggable/resizable webcam overlay whose layout is saved so the
 * server-side composite matches the live preview exactly. */

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Insert mode: opened from the editor's timeline right-click. The recording
// becomes its own session, then attaches to the original one at `insertAt`.
const urlParams = new URLSearchParams(location.search);
const insertFor = urlParams.get('insertFor');
const insertAt = parseFloat(urlParams.get('at') || '0') || 0;

let screenStream = null;
let camStream = null;
let micStream = null;
let screenRec = null;
let camRec = null;
let recording = false;
let sessionId = null;
let timerInterval = null;
let recStartWallMs = 0;
let startTimes = { screen: 0, webcam: 0 };

if (insertFor) {
  // textContent, not HTML — insertFor comes from the URL, so any page could
  // link here with markup in the parameter
  const hint = document.createElement('span');
  hint.className = 'hint';
  hint.textContent = `⏺ recording an INSERT for “${insertFor}” — attaches at ${insertAt.toFixed(1)}s when you stop`;
  document.querySelector('h1').after(hint);
}

// ---------- device pickers ----------
async function fillDevices() {
  try {
    // Prompt once so device labels become visible.
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    tmp.getTracks().forEach(t => t.stop());
  } catch {}
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter(d => d.kind === 'videoinput');
  const mics = devices.filter(d => d.kind === 'audioinput');
  $('camSelect').innerHTML = cams.map(d => `<option value="${esc(d.deviceId)}">${esc(d.label || 'Camera')}</option>`).join('');
  $('micSelect').innerHTML = mics.map(d => `<option value="${esc(d.deviceId)}">${esc(d.label || 'Microphone')}</option>`).join('');

  // default to the Mac's own mic, not iPhone/Continuity devices — but a
  // previously used mic (still connected) wins
  const remembered = localStorage.getItem('studio-mic');
  const pick =
    (remembered && mics.find(d => d.deviceId === remembered)) ||
    mics.find(d => /macbook|built-in/i.test(d.label)) ||
    mics.find(d => !/iphone|ipad|continuity/i.test(d.label)) ||
    mics[0];
  if (pick) $('micSelect').value = pick.deviceId;
}
fillDevices();
$('micSelect').addEventListener('change', () => localStorage.setItem('studio-mic', $('micSelect').value));

// ---------- screen picking ----------
let mode = 'screen';   // 'screen' | 'screen-only' | 'webcam'

async function startScreen(withCam) {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: $('sysAudio').checked,
      selfBrowserSurface: 'exclude',   // don't offer this tab in the picker
      surfaceSwitching: 'include',
    });
  } catch { return; }
  mode = withCam ? 'screen' : 'screen-only';
  $('screenPreview').style.transform = 'none';
  $('screenPreview').srcObject = screenStream;
  $('stageHint').style.display = 'none';
  // capturing a whole monitor that shows this preview = infinity mirror;
  // cover the live preview (the recording itself is unaffected)
  const surface = screenStream.getVideoTracks()[0].getSettings().displaySurface;
  $('previewCover').classList.toggle('hidden', surface !== 'monitor');
  $('recordBtn').disabled = false;
  screenStream.getVideoTracks()[0].onended = () => { if (recording) stopRecording(); };
  if (withCam) {
    $('useWebcam').checked = true;
    startWebcam();
  } else {
    // no camera — but keep the MIC as its own audio track for the transcript
    stopWebcam();
    $('useWebcam').checked = false;
    try {
      camStream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: $('micSelect').value ? { exact: $('micSelect').value } : undefined,
                 echoCancellation: true, noiseSuppression: true },
      });
      setStatus('Screen only — mic is still recorded for the transcript');
    } catch (e) { setStatus('Mic unavailable: ' + e.message); }
  }
}

$('pickScreen').onclick = () => startScreen(true);
$('screenOnly').onclick = () => startScreen(false);

// webcam-only: the camera IS the recording — full-stage preview, no screen
$('webcamOnly').onclick = async () => {
  if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }
  stopWebcam();
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: $('camSelect').value ? { exact: $('camSelect').value } : undefined,
               width: 1920, height: 1080 },
      audio: { deviceId: $('micSelect').value ? { exact: $('micSelect').value } : undefined,
               echoCancellation: true, noiseSuppression: true },
    });
  } catch (e) { setStatus('Webcam error: ' + e.message); return; }
  mode = 'webcam';
  $('previewCover').classList.add('hidden');
  $('screenPreview').srcObject = camStream;
  $('screenPreview').style.transform = 'scaleX(-1)';  // mirrored preview only — the file is not mirrored
  $('stageHint').style.display = 'none';
  $('camBox').classList.add('hidden');
  $('recordBtn').disabled = false;
  setStatus('Webcam-only mode — the camera fills the frame');
};

// ---------- webcam ----------
async function startWebcam() {
  stopWebcam();
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: $('camSelect').value ? { exact: $('camSelect').value } : undefined, width: 1280, height: 720 },
      audio: { deviceId: $('micSelect').value ? { exact: $('micSelect').value } : undefined,
               echoCancellation: true, noiseSuppression: true },
    });
  } catch (e) { setStatus('Webcam/mic error: ' + e.message); return; }
  $('camPreview').srcObject = camStream;
  $('camBox').classList.remove('hidden');
  applyCamStyle();
}
function stopWebcam() {
  if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; }
  $('camBox').classList.add('hidden');
}
$('useWebcam').onchange = e => e.target.checked ? (screenStream && startWebcam()) : stopWebcam();
$('camSelect').onchange = () => { if (mode === 'webcam') $('webcamOnly').onclick(); else if (camStream) startWebcam(); };
$('micSelect').onchange = () => { if (mode === 'webcam') $('webcamOnly').onclick(); else if (camStream) startWebcam(); };

// ---------- overlay layout (normalized to the screen video frame) ----------
const layout = { x: 0.72, y: 0.68, w: 0.24, aspect: 1, radius: 12, mirror: true };

function stageVideoRect() {
  // The visible area of the screen video inside the stage (letterboxing-aware).
  const stage = $('stage').getBoundingClientRect();
  const v = $('screenPreview');
  if (!v.videoWidth) return stage;
  const scale = Math.min(stage.width / v.videoWidth, stage.height / v.videoHeight);
  const w = v.videoWidth * scale, h = v.videoHeight * scale;
  return { left: stage.left + (stage.width - w) / 2, top: stage.top + (stage.height - h) / 2, width: w, height: h };
}

function applyCamStyle() {
  const r = stageVideoRect();
  const stage = $('stage').getBoundingClientRect();
  const w = layout.w * r.width;
  const h = w / layout.aspect;
  const box = $('camBox');
  box.style.width = w + 'px';
  box.style.height = h + 'px';
  box.style.left = (r.left - stage.left + layout.x * r.width) + 'px';
  box.style.top = (r.top - stage.top + layout.y * r.height) + 'px';
  box.style.borderRadius = layout.radius + '%';
  $('camPreview').style.transform = layout.mirror ? 'scaleX(-1)' : 'none';
}

$('camShape').onchange = e => { layout.aspect = parseFloat(e.target.value); clampLayout(); applyCamStyle(); };
$('camRadius').oninput = e => { layout.radius = +e.target.value; $('radiusVal').textContent = layout.radius + '%'; applyCamStyle(); };
$('camMirror').onchange = e => { layout.mirror = e.target.checked; applyCamStyle(); };
window.addEventListener('resize', applyCamStyle);
$('screenPreview').addEventListener('loadedmetadata', applyCamStyle);

function clampLayout() {
  const r = stageVideoRect();
  layout.w = Math.min(Math.max(layout.w, 0.08), 0.6);
  const hNorm = (layout.w * r.width / layout.aspect) / r.height;
  layout.x = Math.min(Math.max(layout.x, 0), 1 - layout.w);
  layout.y = Math.min(Math.max(layout.y, 0), Math.max(0, 1 - hNorm));
}

// drag the bubble to move it; drag ANY edge or corner to resize (the
// cursor becomes a resize arrow when hovering one). Opposite side anchors.
(() => {
  const EDGE = 10; // px hit zone along each edge
  const CURSORS = {
    nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
    n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', move: 'grab',
  };
  let act = null;

  function zoneFor(e) {
    const b = $('camBox').getBoundingClientRect();
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

  $('camBox').addEventListener('pointermove', e => {
    if (!act) $('camBox').style.cursor = CURSORS[zoneFor(e)];
  });

  $('camBox').addEventListener('pointerdown', e => {
    const z = e.target.id === 'camHandle' ? 'se' : zoneFor(e);
    const r = stageVideoRect();
    const hN = (layout.w * r.width / layout.aspect) / r.height;
    act = { z, sx: e.clientX, sy: e.clientY, s: { ...layout, hN } };
    e.preventDefault(); e.stopPropagation();
  });

  window.addEventListener('pointermove', e => {
    if (!act) return;
    const r = stageVideoRect();
    const dx = (e.clientX - act.sx) / r.width;
    const dy = (e.clientY - act.sy) / r.height;
    const { z, s } = act;
    if (z === 'move') {
      layout.x = s.x + dx;
      layout.y = s.y + dy;
    } else {
      // width candidates from each axis; corners follow the stronger pull
      const wFromX = z.includes('e') ? s.w + dx : z.includes('w') ? s.w - dx : null;
      const hDelta = z.includes('s') ? dy : z.includes('n') ? -dy : null;
      const wFromY = hDelta === null ? null
        : (s.hN + hDelta) * r.height * layout.aspect / r.width;
      let wN;
      if (wFromX !== null && wFromY !== null) {
        wN = Math.abs(wFromX - s.w) >= Math.abs(wFromY - s.w) ? wFromX : wFromY;
      } else {
        wN = wFromX !== null ? wFromX : wFromY;
      }
      wN = Math.min(Math.max(wN, 0.08), 0.6);
      layout.w = wN;
      const hN2 = (wN * r.width / layout.aspect) / r.height;
      if (z.includes('w')) layout.x = s.x + s.w - wN;      // right edge anchored
      if (z.includes('n')) layout.y = s.y + s.hN - hN2;    // bottom edge anchored
    }
    clampLayout(); applyCamStyle();
  });
  window.addEventListener('pointerup', () => act = null);
})();

// ---------- recording ----------
function pickMime() {
  for (const m of ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

$('recordBtn').onclick = () => {
  if (recording) return stopRecording();
  if (retrySave) { const r = retrySave; retrySave = null; return r(); }
  countdownAndStart();
};

let counting = false;
async function countdownAndStart() {
  if (counting) return;   // a second click during 3-2-1 must not double-start
  counting = true;
  const cd = $('countdown');
  cd.classList.remove('hidden');
  for (const n of [3, 2, 1]) {
    cd.textContent = n;
    await new Promise(r => setTimeout(r, 700));
  }
  cd.classList.add('hidden');
  counting = false;
  startRecording();
}

function startRecording() {
  if (mode === 'webcam' ? !camStream : !screenStream) return;
  sessionId = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19) + '-rec';
  const mime = pickMime();
  const screenChunks = [], camChunks = [];

  if (mode !== 'webcam') {   // 'screen' and 'screen-only' both capture the screen
    screenRec = new MediaRecorder(screenStream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
    screenRec.ondataavailable = e => e.data.size && screenChunks.push(e.data);
    screenRec.onstart = () => startTimes.screen = performance.now();
  } else {
    screenRec = null;
  }

  if (camStream) {
    const camMime = camStream.getVideoTracks().length ? mime : 'audio/webm;codecs=opus';
    camRec = new MediaRecorder(camStream, { mimeType: camMime, videoBitsPerSecond: 4_000_000 });
    camRec.ondataavailable = e => e.data.size && camChunks.push(e.data);
    camRec.onstart = () => startTimes.webcam = performance.now();
  }

  let pending = (screenRec ? 1 : 0) + (camRec ? 1 : 0);
  const onStop = () => { if (--pending === 0) saveAll(screenChunks, camChunks, mime); };
  if (screenRec) screenRec.onstop = onStop;
  if (camRec) camRec.onstop = onStop;

  if (screenRec) screenRec.start(1000);
  if (camRec) camRec.start(1000);

  recording = true;
  recStartWallMs = Date.now();
  $('recordBtn').textContent = '■ Stop';
  $('recordBtn').classList.add('recording');
  const t0 = Date.now();
  timerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000);
    $('timer').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 250);
  setStatus('Recording…');
}

function stopRecording() {
  recording = false;
  clearInterval(timerInterval);
  $('recordBtn').textContent = '● Record';
  $('recordBtn').classList.remove('recording');
  setStatus('Saving…');
  try { screenRec && screenRec.state !== 'inactive' && screenRec.stop(); } catch {}
  try { camRec && camRec.state !== 'inactive' && camRec.stop(); } catch {}
}

async function saveAll(screenChunks, camChunks, mime) {
  const up = async (name, body) => {
    const r = await fetch(`/api/upload?session=${sessionId}&name=${name}`, { method: 'POST', body });
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  };
  try {
    setStatus('Saving…');
    await doSave(up, screenChunks, camChunks, mime);
  } catch (e) {
    // recording is still in memory — the user can retry instead of losing it
    setStatus(`⚠ Save failed (${e.message}) — is the server still running? ` +
              'Fix it, then press the button to retry.');
    retrySave = () => saveAll(screenChunks, camChunks, mime);
    $('recordBtn').textContent = '↻ Retry save';
  }
}
let retrySave = null;

async function doSave(up, screenChunks, camChunks, mime) {

  const meta = {
    createdAt: new Date().toISOString(),
    mime,
    mode,
    screenStartMs: startTimes.screen,
    webcamStartMs: startTimes.webcam,
    // + means webcam recorder started AFTER the screen recorder
    webcamOffsetSec: (camRec && screenRec) ? (startTimes.webcam - startTimes.screen) / 1000 : 0,
    screenSize: { w: $('screenPreview').videoWidth, h: $('screenPreview').videoHeight },
    hasWebcam: !!camRec && camStream.getVideoTracks().length > 0,
    micOnly: !!camRec && camStream.getVideoTracks().length === 0,
  };

  if (screenChunks.length) await up('screen.webm', new Blob(screenChunks, { type: mime }));
  if (camChunks.length) await up('webcam.webm', new Blob(camChunks, { type: mime }));
  await up('layout.json', new Blob([JSON.stringify(layout, null, 2)], { type: 'application/json' }));
  await up('meta.json', new Blob([JSON.stringify(meta, null, 2)], { type: 'application/json' }));

  setStatus('');
  $('setup').classList.add('hidden');
  $('done').classList.remove('hidden');
  $('savedPath').textContent = `recordings/${sessionId}/`;
  $('editLink').href = `editor.html?session=${sessionId}`;

  if (insertFor) {
    // build the composite, then attach to the original session's timeline
    $('done').querySelector('h2').textContent = 'Insert recorded — attaching…';
    $('processBtn').classList.add('hidden');
    $('jobLog').classList.remove('hidden');
    await runJob('composite');
    const dur = (Date.now() - recStartWallMs) / 1000;
    await fetch(`/api/register-insert?session=${encodeURIComponent(insertFor)}&from=${sessionId}` +
                `&at=${insertAt}&duration=${dur.toFixed(2)}`, { method: 'POST' });
    $('done').querySelector('h2').textContent = `Insert attached ✔ (at ${insertAt.toFixed(1)}s)`;
    $('editLink').href = `editor.html?session=${encodeURIComponent(insertFor)}`;
    $('editLink').textContent = 'Back to the editor';
  }
}

// ---------- post-processing ----------
$('processBtn').onclick = async () => {
  $('processBtn').disabled = true;
  $('jobLog').classList.remove('hidden');
  try {
    await runJob('composite');
    await runJob('transcribe');
    $('jobLog').textContent += '\nAll done — open the editor to review the transcript.';
  } catch (e) {
    $('jobLog').textContent += `\n⚠ ${e.message}`;
  } finally {
    $('processBtn').disabled = false;
  }
};

async function runJob(name) {
  await fetch(`/api/${name}?session=${sessionId}`, { method: 'POST' });
  let misses = 0;
  for (;;) {
    await new Promise(r => setTimeout(r, 1500));
    let j;
    try {
      j = await (await fetch(`/api/job?session=${sessionId}`)).json();
      misses = 0;
    } catch (e) {
      // transient poll failure (server restarting?) — keep trying a bit
      if (++misses >= 5) throw new Error(`lost contact with the server during ${name}`);
      continue;
    }
    $('jobLog').textContent = `[${name}] ${j.status}\n` + (j.tail || '');
    $('jobLog').scrollTop = $('jobLog').scrollHeight;
    if (j.status !== 'running') return j;
  }
}

$('againBtn').onclick = () => location.reload();
function setStatus(s) { $('status').textContent = s; }
