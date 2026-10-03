import * as THREE from '/vendor/three/three.module.min.js';

console.log('SCAN VERSION 1004');

window.THREE = THREE;

const parts = location.pathname
  .split('/')
  .filter(Boolean);

const mode =
  parts[0] === 'scan' && parts[1]
    ? 'project'
    : 'common';

const token =
  mode === 'project'
    ? parts[1]
    : null;

let catalog = [];
let targetData = [];
let active = null;
let mesh = null;
let texture = null;
let video = null;
let tracked = false;
let soundEnabled = false;

const $ = id => document.getElementById(id);

const esc = value =>
  String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));

async function getJson(url) {
  const response = await fetch(url, {
    cache: 'no-store'
  });

  const data = await response
    .json()
    .catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data.error || `HTTP ${response.status}`
    );
  }

  return data;
}

function showSplash(title, text) {
  $('app').innerHTML = `
    <div class="splash">
      <div class="mark">AR</div>
      <div class="eyebrow">8TH WALL ENGINE</div>
      <h1>${esc(title)}</h1>
      <p>${esc(text)}</p>
      <button id="retry">Обновить</button>
    </div>
  `;

  $('retry')?.addEventListener(
    'click',
    () => location.reload()
  );
}

function buildShell(title) {
  $('app').innerHTML = `
    <canvas id="camera"></canvas>

    <video
      id="ar-video"
      playsinline
      webkit-playsinline
      loop
      crossorigin="anonymous">
    </video>

    <header>
      <b>AR SCANNER</b>
      <span>${esc(title)}</span>
      <i>● LIVE</i>
    </header>

    <div id="hint">
      Наведите камеру на фотографию
    </div>

    <div id="start" class="start">
      <div class="mark">AR</div>
      <div class="eyebrow">IMAGE TRACKING</div>
      <h1>Оживите фотографии</h1>
      <p>
        Разрешите доступ к камере
        и наведите её на фотографию.
      </p>

      <button id="go">
        Запустить камеру
      </button>

      <div id="startError"></div>
    </div>

    <div id="name"></div>

    <button id="sound" class="sound hidden">
      🔇 Включить звук
    </button>

    <div id="error" class="toast error" hidden></div>
  `;
}

function showError(message) {
  const element = $('error');

  if (!element) return;

  element.textContent = message;
  element.hidden = false;
}

function findItem(id) {
  return catalog.find(item => item.id === id);
}

/*
  Горизонтальные маркеры поворачиваются.
  Вертикальные остаются без поворота.
*/
function orientVideoTexture(item) {
  if (
    !texture ||
    !video ||
    !video.videoWidth ||
    !video.videoHeight
  ) {
    return;
  }

  const isLandscape =
    Number(item.width || 1) >=
    Number(item.height || 1);

  texture.center.set(0.5, 0.5);

  texture.rotation = isLandscape
    ? -Math.PI / 2
    : 0;

  texture.needsUpdate = true;
}

function pose({ detail } = {}) {
  if (!detail?.name || !mesh || !video) {
    return;
  }

  const item = findItem(detail.name);

  if (!item) {
    return;
  }

  active = item;
  tracked = true;

  const markerWidth = Number(
    detail.scaledWidth || 1
  );

  const markerHeight = Number(
    detail.scaledHeight ||
    markerWidth *
      (
        Number(item.height || 1) /
        Math.max(
          1,
          Number(item.width || 1)
        )
      )
  );

  const isLandscape =
    Number(item.width || 1) >=
    Number(item.height || 1);

  /*
    Уменьшаем только горизонтальные маркеры.
    Вертикальные остаются полного размера.
  */
  const sizeCorrection =
    isLandscape ? 0.88 : 1;

  mesh.position.copy(detail.position);
  mesh.quaternion.copy(detail.rotation);

  if (isLandscape) {
    mesh.scale.set(
      detail.scale * markerHeight * 0.57,
      detail.scale * markerWidth * 0.57,
      1
    );
  } else {
    mesh.scale.set(
      detail.scale * markerWidth,
      detail.scale * markerHeight,
      1
    );
  }

  mesh.visible = true;

  $('hint').textContent =
    item.title || 'Фото распознано';

  $('name').textContent =
    item.title || '';

  $('name').classList.add('show');
  $('sound').classList.remove('hidden');

  const videoUrl = new URL(
    item.videoUrl,
    location.href
  ).href;

  if (video.src !== videoUrl) {
    video.src = item.videoUrl;
    video.load();

    video.addEventListener(
      'loadedmetadata',
      () => {
        orientVideoTexture(item);
      },
      { once: true }
    );
  }

  orientVideoTexture(item);

  video.muted = !soundEnabled;
  video.volume = 1;

  video.play().catch(() => {});
}

function lost({ detail } = {}) {
  if (
    detail?.name &&
    active &&
    detail.name !== active.id
  ) {
    return;
  }

  tracked = false;

  if (mesh) {
    mesh.visible = false;
  }

  if (video) {
    video.pause();
  }

  $('hint').textContent =
    'Наведите камеру на фотографию';

  $('name').classList.remove('show');
  $('sound').classList.add('hidden');
}

function createPipeline() {
  return {
    name: 'premium-video-plane',

    onStart: () => {
      const {
        scene,
        camera,
        renderer
      } = XR8.Threejs.xrScene();

      scene.background = null;

      renderer.outputColorSpace =
        THREE.LinearSRGBColorSpace;

      texture = new THREE.VideoTexture(video);

      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.colorSpace = THREE.SRGBColorSpace;

      const material =
        new THREE.MeshBasicMaterial({
          map: texture,
          transparent: true,
          side: THREE.DoubleSide,
          toneMapped: false,
          depthWrite: false
        });

      mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        material
      );

      mesh.visible = false;

      scene.add(mesh);

      camera.position.set(0, 0, 0);

      XR8.XrController
        .updateCameraProjectionMatrix({
          origin: camera.position,
          facing: camera.quaternion
        });

      $('start').hidden = true;
      $('hint').hidden = false;
    },

    onUpdate: () => {
      if (!mesh || !tracked || !video) {
        return;
      }

      mesh.visible =
        video.readyState >= 2 &&
        !video.paused;
    },

    listeners: [
      {
        event: 'reality.imagefound',
        process: pose
      },
      {
        event: 'reality.imageupdated',
        process: pose
      },
      {
        event: 'reality.imagelost',
        process: lost
      }
    ],

    onException: error => {
      showError(
        `Ошибка AR: ${error?.message || error}`
      );
    },

    onCameraStatusChange: ({ status }) => {
      if (status === 'failed') {
        showError(
          'Камера недоступна. Разрешите камеру и откройте HTTPS-ссылку заново.'
        );
      }
    }
  };
}

function loadEngine() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          'Движок долго загружается.'
        )
      );
    }, 60000);

    window.addEventListener(
      'xrloaded',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );

    const script =
      document.createElement('script');

    script.src = '/vendor/xr/xr.js';
    script.async = true;
    script.dataset.preloadChunks = 'slam';

    script.onerror = () => {
      reject(
        new Error(
          'Не удалось загрузить 8th Wall Engine.'
        )
      );
    };

    document.head.appendChild(script);
  });
}

async function start() {
  const button = $('go');

  button.disabled = true;

  $('startError').textContent =
    'Разрешите доступ к камере…';

  try {
    if (
      !window.isSecureContext &&
      location.hostname !== 'localhost'
    ) {
      throw new Error(
        'Для камеры нужен HTTPS.'
      );
    }

    const canvas = $('camera');

    canvas.width = innerWidth;
    canvas.height = innerHeight;

    video = $('ar-video');

    video.muted = true;
    video.volume = 1;
    video.playsInline = true;

    video.setAttribute(
      'webkit-playsinline',
      ''
    );

    XR8.XrController.configure({
      disableWorldTracking: true,
      imageTargetData: targetData
    });

    XR8.addCameraPipelineModules([
      XR8.GlTextureRenderer.pipelineModule(),
      XR8.Threejs.pipelineModule(),
      XR8.XrController.pipelineModule(),
      createPipeline()
    ]);

    XR8.run({
      canvas,
      allowedDevices: XR8.XrConfig.device().ANY
    });

    $('startError').textContent = '';

  } catch (error) {
    button.disabled = false;

    $('startError').textContent =
      error.message ||
      'Не удалось запустить камеру.';
  }
}

window.addEventListener('resize', () => {
  const canvas = $('camera');

  if (!canvas) return;

  canvas.width = innerWidth;
  canvas.height = innerHeight;
});

(async () => {
  try {
    const data =
      mode === 'project'
        ? await getJson(
            `/api/public/project/${encodeURIComponent(token)}`
          )
        : await getJson(
            '/api/admin/common-catalog'
          );

    catalog =
      mode === 'project'
        ? data.project?.items || []
        : data.projects || [];

    targetData = await getJson(
      data.targetUrl
    );

    if (
      !catalog.length ||
      !targetData.length
    ) {
      return showSplash(
        'Проект пока пуст',
        'Добавьте пары фото и видео в админке.'
      );
    }

    buildShell(
      mode === 'project'
        ? data.project.name
        : 'Общий тестовый сканер'
    );

    await loadEngine();

    $('go').addEventListener(
      'click',
      start,
      { once: true }
    );

    $('sound').addEventListener(
      'click',
      () => {
        if (!video) return;

        soundEnabled = !soundEnabled;

        video.muted = !soundEnabled;
        video.volume = 1;

        if (soundEnabled) {
          video.play().catch(() => {});
        }

        $('sound').textContent =
          soundEnabled
            ? '🔊 Выключить звук'
            : '🔇 Включить звук';
      }
    );

  } catch (error) {
    showSplash(
      'Не удалось открыть сканер',
      error.message || 'Ошибка'
    );
  }
})();
