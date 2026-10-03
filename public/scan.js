import * as THREE from '/vendor/three/three.module.min.js';
window.THREE = THREE;
const parts = location.pathname.split('/').filter(Boolean);
const mode = parts[0] === 'scan' && parts[1] ? 'project' : 'common';
const token = mode === 'project' ? parts[1] : null;
let catalog = [], targetData = [], active = null, mesh, texture, video;
let soundEnabled = false;
let tracked = false;
const desired = {position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), scale: new THREE.Vector3(1, 1, 1)};
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function getJson(url) { const r = await fetch(url, {cache: 'no-store'}); const d = await r.json().catch(() => ({})); if (!r.ok) throw Error(d.error || `HTTP ${r.status}`); return d; }
function splash(title, text, retry = true) { $('app').innerHTML = `<div class="splash"><div class="mark">AR</div><div class="eyebrow">8TH WALL ENGINE</div><h1>${esc(title)}</h1><p>${esc(text)}</p>${retry ? '<button id="retry">Обновить</button>' : ''}</div>`; $('retry')?.addEventListener('click', () => location.reload()); }
function buildShell(title) { $('app').innerHTML = `<canvas id="camera"></canvas><video id="ar-video" playsinline webkit-playsinline loop crossorigin="anonymous"></video><header><b>AR SCANNER</b><span>${esc(title)}</span><i>● LIVE</i></header><div id="hint">Наведите камеру на фотографию</div><div id="start" class="start"><div class="mark">AR</div><div class="eyebrow">IMAGE TRACKING</div><h1>Оживите фотографии</h1><p>Разрешите камеру и наведите её на один из маркеров проекта.</p><button id="go">Запустить камеру</button><div id="startError"></div></div><div id="name"></div><button id="sound" class="sound hidden">🔇 Включить звук</button><div id="error" class="toast error" hidden></div>`; }
function showError(message) { const el = $('error'); el.textContent = message; el.hidden = false; }
function itemById(id) { return catalog.find(x => x.id === id); }
function pose({detail}) { if (!detail?.name || !mesh) return; const item = itemById(detail.name); if (!item) return; active = item; tracked = true; desired.position.copy(detail.position); desired.quaternion.copy(detail.rotation); const w = Number(detail.scaledWidth || 1), h = Number(detail.scaledHeight || w * (item.height / Math.max(1, item.width))); desired.scale.set(detail.scale * w, detail.scale * h, 1); mesh.position.copy(desired.position); mesh.quaternion.copy(desired.quaternion); mesh.scale.copy(desired.scale); mesh.visible = true; $('hint').textContent = item.title || 'Фото распознано'; $('name').textContent = item.title || ''; $('name').classList.add('show'); $('sound').classList.remove('hidden'); if (video.src !== new URL(item.videoUrl, location.href).href) { video.src = item.videoUrl; video.load(); } video.muted = !soundEnabled; video.play().catch(() => {}); }
function lost({detail} = {}) { if (detail.name && active && detail.name !== active.id) return; tracked = false; if (mesh) mesh.visible = false; video?.pause(); $('hint').textContent = 'Наведите камеру на фотографию'; $('name').classList.remove('show'); $('sound').classList.add('hidden'); }
function pipeline() { return {name: 'premium-video-plane', onStart: ({canvas}) => { const {scene, camera, renderer} = XR8.Threejs.xrScene(); scene.background = null; renderer.outputColorSpace = THREE.LinearSRGBColorSpace; texture = new THREE.VideoTexture(video); texture.minFilter = THREE.LinearFilter; texture.magFilter = THREE.LinearFilter; mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({map: texture, transparent: true, side: THREE.DoubleSide, toneMapped: false, depthWrite: false})); mesh.visible = false; scene.add(mesh); camera.position.set(0, 0, 0); XR8.XrController.updateCameraProjectionMatrix({origin: camera.position, facing: camera.quaternion}); $('start').hidden = true; $('hint').hidden = false; }, onUpdate: () => { if (mesh && tracked) mesh.visible = video.readyState >= 2 && !video.paused; }, listeners: [{event:'reality.imagefound', process: pose}, {event:'reality.imageupdated', process: pose}, {event:'reality.imagelost', process: lost}], onException: e => showError(`Ошибка AR: ${e?.message || e}`), onCameraStatusChange: ({status}) => { if (status === 'failed') showError('Камера недоступна. Разрешите камеру в Safari и откройте HTTPS-ссылку заново.'); } }; }
function loadEngine() { return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Движок долго загружается.')), 60000); const done = () => { clearTimeout(timer); resolve(); }; window.addEventListener('xrloaded', done, {once: true}); const script = document.createElement('script'); script.src = '/vendor/xr/xr.js'; script.async = true; script.dataset.preloadChunks = 'slam'; script.onerror = () => reject(Error('Не удалось загрузить 8th Wall Engine.')); document.head.append(script); }); }
async function start() { const button = $('go'); button.disabled = true; $('startError').textContent = 'Разрешите доступ к камере…'; try { if (!window.isSecureContext && location.hostname !== 'localhost') throw Error('Для камеры нужен HTTPS.'); const canvas = $('camera'); canvas.width = innerWidth; canvas.height = innerHeight; video = $('ar-video'); video.muted = !soundEnabled; XR8.XrController.configure({disableWorldTracking: true, imageTargetData: targetData}); XR8.addCameraPipelineModules([XR8.GlTextureRenderer.pipelineModule(), XR8.Threejs.pipelineModule(), XR8.XrController.pipelineModule(), pipeline()]); XR8.run({canvas, allowedDevices: XR8.XrConfig.device().ANY}); $('startError').textContent = ''; } catch (e) { button.disabled = false; $('startError').textContent = e.message || 'Не удалось запустить камеру.'; } }
window.addEventListener('resize', () => { const c = $('camera'); if (c) { c.width = innerWidth; c.height = innerHeight; } });
(async () => { try { const data = mode === 'project' ? await getJson(`/api/public/project/${encodeURIComponent(token)}`) : await getJson('/api/admin/common-catalog'); catalog = mode === 'project' ? (data.project?.items || []) : (data.projects || []); targetData = await getJson(data.targetUrl); if (!catalog.length || !targetData.length) return splash('Проект пока пуст', 'Добавьте готовые пары фото и видео в админке.'); buildShell(mode === 'project' ? data.project.name : 'Общий тестовый сканер'); await loadEngine(); $('go').addEventListener('click', start, {once: true}); 
  $('sound').addEventListener('click', () => {
  if (!video) return;

  soundEnabled = !soundEnabled;
  video.muted = !soundEnabled;
  video.volume = 1;

  if (soundEnabled) {
    video.play().catch(() => {});
    $('sound').textContent = '🔊 Выключить звук';
  } else {
    $('sound').textContent = '🔇 Включить звук';
  }
}); } catch (e) { splash('Не удалось открыть сканер', e.message || 'Ошибка'); } })();
