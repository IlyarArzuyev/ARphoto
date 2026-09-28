const root = document.querySelector('#app');
let activeId = null;
let activeVideo = null;
let catalog = [];
let currentScene = null;
let currentVersion = 0;

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

function toast(text, cls = 'info', ms = 3200) {
  const el = document.createElement('div');
  el.className = `toast ${cls}`;
  el.textContent = text;
  root.append(el);
  setTimeout(() => el.remove(), ms);
}

function splash(title, message, buttonText = 'Повторить', handler = boot) {
  root.innerHTML = `
    <div class="splash">
      <div class="mark">AR</div>
      <div class="eyebrow">PHOTO VIDEO</div>
      <h1>${esc(title)}</h1>
      <p>${esc(message)}</p>
      ${buttonText ? `<button id="retry">${esc(buttonText)}</button>` : ''}
    </div>`;
  const btn = document.querySelector('#retry');
  if (btn) btn.onclick = handler;
}

async function catalogData() {
  const response = await fetch(`/api/public/catalog?ts=${Date.now()}`, {
    cache: 'no-store',
    headers: { 'Cache-Control': 'no-cache' }
  });
  if (!response.ok) throw new Error(`AR-база недоступна (${response.status})`);
  return response.json();
}

async function boot() {
  if (!root) return;

  if (!window.AFRAME) {
    splash('Ошибка библиотеки', 'A-Frame не загрузился. Проверьте /vendor/aframe/aframe-v1.5.0.min.js.');
    return;
  }
  if (!window.MINDAR || !window.MINDAR.IMAGE) {
    splash('Ошибка библиотеки', 'MindAR не загрузился. Проверьте /vendor/mind-ar/mindar-image-aframe.prod.js.');
    return;
  }

  root.innerHTML = `
    <div class="splash">
      <div class="mark">AR</div>
      <div class="eyebrow">PHOTO VIDEO</div>
      <h1>AR Scanner</h1>
      <p>Загрузка AR-базы…</p>
    </div>`;

  try {
    const data = await catalogData();
    catalog = Array.isArray(data.items) ? data.items : [];
    currentVersion = Number(data.version || 0);

    if (!data.ready || !catalog.length) {
      splash('Пока пусто', 'В админке ещё нет опубликованных фотографий для сканирования.', 'Обновить');
      return;
    }

    build(currentVersion);
  } catch (error) {
    console.error('[AR BOOT]', error);
    splash('Не удалось открыть сканер', error?.message || 'Неизвестная ошибка');
  }
}

function build(version) {
  root.innerHTML = `
    <div class="wrap">
      <div class="top">
        <div><b>AR SCANNER</b><span>v${version} · ${catalog.length} targets</span></div>
        <div class="live">● LIVE</div>
      </div>
      <div id="scene"></div>
      <div class="reticle"><i></i></div>
      <div class="bottom">
        <div id="instruction">Подготовка камеры…</div>
        <div id="name"></div>
        <button id="sound" class="sound hidden">🔇 Включить звук</button>
      </div>
      <div id="start" class="start">
        <div class="mark">AR</div>
        <div class="eyebrow">СКАНЕР</div>
        <h1>Оживите фотографию</h1>
        <p>Нажмите кнопку, разрешите доступ к камере и наведите телефон на зарегистрированную фотографию.</p>
        <button id="go">Запустить камеру</button>
        <div id="startError" class="start-error"></div>
      </div>
    </div>`;

  const scene = document.createElement('a-scene');
  currentScene = scene;
  scene.setAttribute('embedded', '');
  scene.setAttribute('color-space', 'sRGB');
  scene.setAttribute('mindar-image', `imageTargetSrc: /ar/targets.mind?v=${encodeURIComponent(version)}; autoStart: false; uiLoading: no; uiError: no; uiScanning: no; showStats: false; maxTrack: 1`);
  // Alpha is essential: MindAR puts the real camera video behind A-Frame's canvas.
  scene.setAttribute('renderer', 'alpha: true; antialias: true; colorManagement: true; physicallyCorrectLights: false');
  scene.setAttribute('vr-mode-ui', 'enabled: false');
  scene.setAttribute('device-orientation-permission-ui', 'enabled: false');
  scene.innerHTML = '<a-assets id="assets"></a-assets><a-camera active="true" position="0 0 0" look-controls="enabled: false"></a-camera>';
  document.querySelector('#scene').append(scene);

  const assets = scene.querySelector('#assets');
  catalog.forEach(item => {
    const video = document.createElement('video');
    video.id = `v-${item.id}`;
    video.src = `${item.videoUrl}?v=${encodeURIComponent(item.updatedAt || '')}`;
    video.muted = true;
    video.loop = true;
    video.autoplay = false;
    video.playsInline = true;
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.preload = 'metadata';
    video.crossOrigin = 'anonymous';
    video.addEventListener('error', () => console.warn('[VIDEO ERROR]', item.name, video.error));
    video.addEventListener('loadeddata', () => {
      if (activeId === item.id) console.debug('[VIDEO READY]', item.name, video.videoWidth, video.videoHeight);
    });
    assets.append(video);

    const target = document.createElement('a-entity');
    target.id = `t-${item.id}`;
    target.setAttribute('mindar-image-target', `targetIndex: ${item.targetIndex}`);

    const sourceWidth = Math.max(1, Number(item.width || 1));
    const sourceHeight = Math.max(1, Number(item.height || 1));
    const ratio = sourceHeight / sourceWidth;
    const plane = document.createElement('a-video');
    plane.setAttribute('src', `#v-${item.id}`);
    plane.setAttribute('width', '1');
    plane.setAttribute('height', String(Math.max(0.15, ratio)));
    plane.setAttribute('position', '0 0 0.02');
    plane.setAttribute('rotation', '0 0 0');
    plane.setAttribute('material', 'shader: flat; side: double; transparent: false; opacity: 1');

    target.append(plane);
    scene.append(target);
    target.addEventListener('targetFound', () => found(item, video));
    target.addEventListener('targetLost', () => lost(item, video));
  });

  const startCamera = async () => {
    const start = document.querySelector('#start');
    const errorBox = document.querySelector('#startError');
    const instruction = document.querySelector('#instruction');
    start.classList.add('hidden');
    errorBox.textContent = '';
    instruction.textContent = 'Запуск камеры…';

    try {
      if (!window.isSecureContext && location.hostname !== 'localhost') {
        throw new Error('Сканер должен открываться по HTTPS. Откройте ссылку Cloudflare.');
      }
      const ar = scene.systems['mindar-image-system'];
      if (!ar) throw new Error('MindAR не инициализировался. Обновите страницу.');
      await ar.start();
      requestAnimationFrame(() => {
        fixCameraVideoLayer();
        requestAnimationFrame(fixCameraVideoLayer);
      });
      instruction.textContent = 'Наведите камеру на фотографию';
    } catch (error) {
      console.error('[AR START]', error);
      start.classList.remove('hidden');
      errorBox.textContent = error?.message || 'Не удалось запустить камеру.';
      toast('Камеру не удалось запустить', 'error', 5000);
    }
  };

  const onLoaded = () => {
    const go = document.querySelector('#go');
    if (go) go.onclick = startCamera;
  };

  scene.addEventListener('loaded', onLoaded, { once: true });
  if (scene.hasLoaded) onLoaded();
}

function fixCameraVideoLayer() {
  const cameraVideo = document.querySelector('#scene > video');
  if (!cameraVideo) return;

  cameraVideo.style.setProperty('position', 'absolute', 'important');
  cameraVideo.style.setProperty('top', '0', 'important');
  cameraVideo.style.setProperty('left', '0', 'important');
  cameraVideo.style.setProperty('width', '100%', 'important');
  cameraVideo.style.setProperty('height', '100%', 'important');
  cameraVideo.style.setProperty('object-fit', 'cover', 'important');
  cameraVideo.style.setProperty('z-index', '0', 'important');
  cameraVideo.style.setProperty('display', 'block', 'important');
  cameraVideo.style.setProperty('opacity', '1', 'important');
  cameraVideo.style.setProperty('visibility', 'visible', 'important');

  console.debug('[CAMERA VIDEO]', {
    readyState: cameraVideo.readyState,
    videoWidth: cameraVideo.videoWidth,
    videoHeight: cameraVideo.videoHeight,
    paused: cameraVideo.paused,
    zIndex: getComputedStyle(cameraVideo).zIndex
  });
}

function found(item, video) {
  activeId = item.id;
  activeVideo = video;
  const instruction = document.querySelector('#instruction');
  const name = document.querySelector('#name');
  const sound = document.querySelector('#sound');

  instruction.textContent = 'Фото распознано';
  name.textContent = item.name;
  name.classList.add('show');
  sound.classList.remove('hidden');

  const reticle = document.querySelector('.reticle');
  const targetWidth = Math.max(1, Number(item.width || 1));
  const targetHeight = Math.max(1, Number(item.height || 1));
  if (reticle) reticle.style.aspectRatio = `${targetWidth} / ${targetHeight}`;

  video.currentTime = 0;
  video.muted = true;
  const playPromise = video.play();
  if (playPromise?.catch) {
    playPromise.catch(error => console.debug('[VIDEO PLAY]', error));
  }

  // A common iPhone failure mode is an audio-capable video with no decoded video frames
  // (unsupported codec/container). Tell the user instead of leaving a black AR plane.
  setTimeout(() => {
    if (activeId !== item.id) return;
    if (!video.videoWidth || !video.videoHeight) {
      toast('Видео не декодируется. Используйте MP4 (H.264 + AAC).', 'error', 6000);
    }
  }, 900);

  toast(item.name, 'success');
}

function lost(item, video) {
  if (activeId !== item.id) return;
  video.pause();
  activeId = null;
  activeVideo = null;
  document.querySelector('#instruction').textContent = 'Наведите камеру на фотографию';
  document.querySelector('#name').classList.remove('show');
  const reticle = document.querySelector('.reticle');
  if (reticle) reticle.style.aspectRatio = '1 / 1';
  document.querySelector('#sound').classList.add('hidden');
}

document.addEventListener('click', event => {
  if (event.target.id === 'sound' && activeVideo) {
    activeVideo.muted = false;
    activeVideo.volume = 0.9;
    activeVideo.play().catch(() => {});
    event.target.textContent = '🔇 Включить звук';
    setTimeout(() => event.target.classList.add('hidden'), 1400);
  }
});

function events() {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  let ws;
  try { ws = new WebSocket(`${protocol}://${location.host}/ws`); }
  catch { return; }
  ws.addEventListener('message', (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.event === 'ar-updated' || data.event === 'catalog-updated') {
        toast('AR-база обновлена. Перезагружаю сканер…', 'info', 2500);
        setTimeout(() => location.reload(), 700);
      }
    } catch (error) {
      console.warn('[WS]', error);
    }
  });
  ws.addEventListener('close', () => setTimeout(events, 5000));
}

window.addEventListener('resize', () => setTimeout(fixCameraVideoLayer, 50));
window.addEventListener('orientationchange', () => setTimeout(fixCameraVideoLayer, 100));
window.addEventListener('error', event => console.error('[PAGE ERROR]', event.error || event.message));
window.addEventListener('unhandledrejection', event => console.error('[PROMISE ERROR]', event.reason));

events();
boot();
