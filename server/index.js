import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { buildImageTarget } from './targets.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const IMAGE_DIR = path.join(MEDIA_DIR, 'images');
const VIDEO_DIR = path.join(MEDIA_DIR, 'videos');
const TARGET_DIR = path.join(DATA_DIR, 'targets');
const COMMON_TARGET = path.join(TARGET_DIR, 'common.json');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(ROOT, 'public');

const PORT = Number(process.env.PORT || 3000);
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-now';
const COOKIE_NAME = 'ar_admin';
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';
const MAX_VIDEO_BYTES = Number(process.env.MAX_VIDEO_BYTES || 524_288_000);
const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_BYTES || 20_971_520);
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;

const sessions = new Map();
const wsClients = new Set();
let buildQueue = Promise.resolve();
let buildRunning = false;
let buildPending = false;
let lastBuildError = null;

await Promise.all([
  fs.mkdir(IMAGE_DIR, { recursive: true }),
  fs.mkdir(VIDEO_DIR, { recursive: true }),
  fs.mkdir(TARGET_DIR, { recursive: true }),
  fs.mkdir(PUBLIC_DIR, { recursive: true }),
]);

function id() { return crypto.randomUUID(); }
function secret(bytes = 20) { return crypto.randomBytes(bytes).toString('base64url'); }
function now() { return new Date().toISOString(); }
function safeExt(name, fallback) {
  const ext = path.extname(name || '').toLowerCase().replace(/[^a-z0-9.]/g, '');
  return ext || fallback;
}
function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(v => v.trim()).filter(Boolean).map(v => {
    const i = v.indexOf('=');
    return i < 0 ? [v, ''] : [decodeURIComponent(v.slice(0, i)), decodeURIComponent(v.slice(i + 1))];
  }));
}
function setCookie(res, token) {
  const parts = [`${COOKIE_NAME}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(SESSION_TTL / 1000)}`];
  if (COOKIE_SECURE) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
function clearCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${COOKIE_SECURE ? '; Secure' : ''}`);
}
function authenticated(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  const expires = token && sessions.get(token);
  if (!expires || expires < Date.now()) {
    if (token) sessions.delete(token);
    return false;
  }
  return true;
}
function requireAdmin(req, res, next) {
  if (!authenticated(req)) return res.status(401).json({ error: 'Требуется вход в админку' });
  next();
}
function requireAdminPage(req, res, next) {
  if (!authenticated(req)) return res.redirect('/admin');
  next();
}
async function writeState(state) {
  const tmp = `${DB_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(tmp, DB_FILE);
}
async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

function normalizeItem(item = {}, projectId) {
  return {
    id: item.id || id(),
    title: String(item.title || item.name || 'Маркер').slice(0, 120),
    imagePath: item.imagePath || null,
    videoPath: item.videoPath || null,
    width: Number(item.width || 1),
    height: Number(item.height || 1),
    targetIndex: Number.isInteger(item.targetIndex) ? item.targetIndex : null,
    targetVersion: Number(item.targetVersion || 0),
    createdAt: item.createdAt || now(),
    updatedAt: item.updatedAt || now(),
    projectId,
  };
}

function normalizeProject(project = {}) {
  const p = {
    id: project.id || id(),
    name: String(project.name || 'Без названия').slice(0, 120),
    scanToken: project.scanToken || secret(),
    uploadToken: project.uploadToken ?? null,
    uploadIssuedAt: project.uploadIssuedAt ?? null,
    uploadUsedAt: project.uploadUsedAt ?? null,
    enabled: project.enabled !== false,
    published: Boolean(project.published),
    targetVersion: Number(project.targetVersion || 0),
    createdAt: project.createdAt || now(),
    updatedAt: project.updatedAt || now(),
    items: Array.isArray(project.items) ? project.items.map(x => normalizeItem(x, project.id)) : [],
  };
  if (!p.items.length && (project.imagePath || project.videoPath)) {
    p.items.push(normalizeItem({
      id: project.itemId || id(),
      title: project.name || 'Маркер',
      imagePath: project.imagePath || null,
      videoPath: project.videoPath || null,
      width: project.width || 1,
      height: project.height || 1,
      targetIndex: 0,
      targetVersion: project.targetVersion || 0,
      createdAt: project.createdAt || now(),
      updatedAt: project.updatedAt || now(),
    }, p.id));
  }
  return p;
}

async function readState() {
  try {
    const raw = JSON.parse(await fs.readFile(DB_FILE, 'utf8'));
    const before = JSON.stringify(raw);
    const state = {
      version: Number(raw.version || 0),
      revision: Number(raw.revision || 0),
      projects: Array.isArray(raw.projects) ? raw.projects.map(normalizeProject) : [],
    };
    const after = JSON.stringify(state);
    if (before !== after) await writeState(state);
    return state;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const state = { version: 0, revision: 0, projects: [] };
    await writeState(state);
    return state;
  }
}

function projectReady(project) {
  return Boolean(project?.items?.some(item => item.imagePath && item.videoPath));
}
function readyItems(project) {
  return (project?.items || []).filter(item => item.imagePath && item.videoPath);
}
function projectByScanToken(state, token) {
  return state.projects.find(p => p.scanToken === token);
}
function projectByUploadToken(state, token) {
  return state.projects.find(p => p.uploadToken === token && !p.uploadUsedAt);
}
function projectTargetPath(project) {
  return path.join(TARGET_DIR, project.id, 'targets.json');
}
function commonItems(state) {
  const out = [];
  let idx = 0;
  for (const project of state.projects) {
    if (!project.enabled) continue;
    for (const item of readyItems(project)) {
      out.push({ project, item, targetIndex: idx++ });
    }
  }
  return out;
}
function itemImageUrl(project, item) { return `/media/project/${project.scanToken}/item/${item.id}/image`; }
function itemVideoUrl(project, item) { return `/media/project/${project.scanToken}/item/${item.id}/video`; }
function publicItem(project, item, targetIndex = item.targetIndex) {
  return {
    id: item.id,
    title: item.title,
    imageUrl: itemImageUrl(project, item),
    videoUrl: itemVideoUrl(project, item),
    width: Number(item.width || 1),
    height: Number(item.height || 1),
    targetIndex,
    targetVersion: item.targetVersion || 0,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ready: Boolean(item.imagePath && item.videoPath),
  };
}
function publicProject(project, includeAdmin = false, commonTargetItems = null) {
  const ready = readyItems(project);
  const base = {
    id: project.id,
    name: project.name,
    scanUrl: `/scan/${project.scanToken}`,
    enabled: project.enabled,
    published: project.published,
    targetVersion: project.targetVersion || 0,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    itemCount: project.items.length,
    readyCount: ready.length,
    ready: ready.length > 0,
    items: commonTargetItems
      ? commonTargetItems.filter(x => x.project.id === project.id).map(x => publicItem(project, x.item, x.targetIndex))
      : ready.map(item => publicItem(project, item, item.targetIndex)),
  };
  if (includeAdmin) {
    base.uploadUrl = project.uploadToken && !project.uploadUsedAt ? `/upload/${project.uploadToken}` : null;
    base.uploadIssuedAt = project.uploadIssuedAt;
    base.uploadUsedAt = project.uploadUsedAt;
    base.items = project.items.map(item => ({
      ...publicItem(project, item, item.targetIndex),
      imagePath: item.imagePath,
      videoPath: item.videoPath,
    }));
  }
  return base;
}

const storage = multer.diskStorage({
  destination: (_req, file, cb) => cb(null, file.fieldname === 'photo' ? IMAGE_DIR : VIDEO_DIR),
  filename: (_req, file, cb) => cb(null, `${id()}${safeExt(file.originalname, file.fieldname === 'photo' ? '.jpg' : '.mp4')}`),
});
const upload = multer({
  storage,
  limits: { files: 2, fieldNameSize: 100, fileSize: MAX_VIDEO_BYTES },
  fileFilter: (_req, file, cb) => {
    if (file.fieldname === 'photo' && /^(image\/(jpeg|png|webp))$/.test(file.mimetype)) return cb(null, true);
    if (file.fieldname === 'video' && /^(video\/(mp4|webm|quicktime))$/.test(file.mimetype)) return cb(null, true);
    cb(new Error(`Недопустимый тип файла: ${file.mimetype}`));
  },
});

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

function broadcast(event, payload = {}) {
  const msg = JSON.stringify({ event, ...payload });
  for (const ws of wsClients) {
    if (ws.readyState !== 1) { wsClients.delete(ws); continue; }
    try { ws.send(msg); } catch { wsClients.delete(ws); }
  }
}

async function buildAllTargets(reason = 'change') {
  if (buildRunning) { buildPending = true; return; }
  buildRunning = true;
  buildPending = false;
  lastBuildError = null;
  try {
    const state = await readState();
    const snapshotRevision = state.revision;
    const enabled = state.projects.filter(p => p.enabled && readyItems(p).length > 0);
    broadcast('build-start', { reason, count: enabled.reduce((sum, p) => sum + readyItems(p).length, 0), revision: snapshotRevision });

    let processed = 0;
    const totalItems = enabled.reduce((sum, p) => sum + readyItems(p).length, 0) || 1;
    const commonImages = [];

    for (const project of enabled) {
      const items = readyItems(project);
      const projectTargetDir = path.join(TARGET_DIR, project.id);
      await fs.rm(projectTargetDir, {recursive: true, force: true});
      await fs.mkdir(projectTargetDir, {recursive: true});
      const targetData = [];

      for (let i = 0; i < items.length; i++) {
        items[i].targetIndex = i;
        items[i].targetVersion = Number(items[i].targetVersion || 0) + 1;
        items[i].updatedAt = now();
        const targetDir = path.join(projectTargetDir, items[i].id);
        const target = await buildImageTarget(
          path.join(IMAGE_DIR, items[i].imagePath), targetDir,
          `/ar/project/${project.scanToken}/targets/${items[i].id}/marker_luminance.png`,
          items[i].id,
        );
        targetData.push(target.metadata);
        commonImages.push({item: items[i], project, file: path.join(IMAGE_DIR, items[i].imagePath)});
        processed += 1;
        broadcast('build-progress', { progress: Math.round(10 + (processed / totalItems) * 45), text: `${project.name} · ${i + 1}/${items.length}` });
      }
      await fs.writeFile(projectTargetPath(project), JSON.stringify(targetData, null, 2));
    }

    if (!commonImages.length) await fs.unlink(COMMON_TARGET).catch(() => {});
    else {
      const commonDir = path.join(TARGET_DIR, 'common');
      await fs.rm(commonDir, {recursive: true, force: true});
      await fs.mkdir(commonDir, {recursive: true});
      const commonData = [];
      for (const [index, entry] of commonImages.entries()) {
        const target = await buildImageTarget(
          entry.file, path.join(commonDir, entry.item.id),
          `/ar/common/targets/${entry.item.id}/marker_luminance.png`, entry.item.id,
        );
        commonData.push(target.metadata);
      }
      await fs.writeFile(COMMON_TARGET, JSON.stringify(commonData, null, 2));
    }

    const latest = await readState();
    if (latest.revision !== snapshotRevision) {
      buildPending = true;
      return;
    }

    const common = commonItems(latest);
    const globalIndex = new Map(common.map(x => [`${x.project.id}:${x.item.id}`, x.targetIndex]));
    for (const project of latest.projects) {
      const ready = readyItems(project);
      project.published = project.enabled && ready.length > 0 && await exists(projectTargetPath(project));
      for (const item of project.items) {
        const newIndex = ready.findIndex(x => x.id === item.id);
        item.targetIndex = newIndex >= 0 ? newIndex : null;
      }
      if (project.published) project.targetVersion = Number(project.targetVersion || 0) + 1;
    }
    latest.version += 1;
    await writeState(latest);
    globalThis.__arVersion = latest.version;
    broadcast('build-progress', { progress: 100, text: 'Готово' });
    broadcast('ar-updated', { version: latest.version, count: common.length });
  } catch (error) {
    console.error('[AR BUILD]', error);
    lastBuildError = error.message;
    broadcast('build-error', { error: error.message });
  } finally {
    buildRunning = false;
    if (buildPending) {
      buildPending = false;
      queueBuild('изменения во время сборки');
    }
  }
}
function queueBuild(reason = 'change') {
  buildPending = true;
  buildQueue = buildQueue.then(async () => {
    if (!buildPending) return;
    buildPending = false;
    await buildAllTargets(reason);
  }).catch(error => console.error('[BUILD QUEUE]', error));
  return buildQueue;
}

async function deleteItemFiles(item) {
  if (!item) return;
  if (item.imagePath) await fs.unlink(path.join(IMAGE_DIR, item.imagePath)).catch(() => {});
  if (item.videoPath) await fs.unlink(path.join(VIDEO_DIR, item.videoPath)).catch(() => {});
}
async function deleteProjectFiles(project) {
  for (const item of project.items || []) await deleteItemFiles(item);
  await fs.unlink(projectTargetPath(project)).catch(() => {});
}

function mediaForItem(project, item, type) {
  const file = type === 'image' ? item.imagePath : item.videoPath;
  const root = type === 'image' ? IMAGE_DIR : VIDEO_DIR;
  if (!project.enabled || !file) return null;
  return path.join(root, path.basename(file));
}
function sendMediaFile(res, file) {
  res.sendFile(file, {
    headers: {
      'Cache-Control': 'public, max-age=0, must-revalidate',
      'Accept-Ranges': 'bytes',
    },
  }, err => {
    if (err && !res.headersSent) res.status(err.statusCode || 404).send('Файл не найден');
  });
}

// Public project scanner
app.get('/api/public/project/:scanToken', async (req, res) => {
  const state = await readState();
  const project = projectByScanToken(state, req.params.scanToken);
  if (!project || !project.enabled) return res.status(404).json({ error: 'Проект не найден или отключён' });
  const items = readyItems(project);
  const target = projectTargetPath(project);
  if (!items.length || !(await exists(target))) return res.status(404).json({ error: 'Проект ещё не готов к сканированию' });
  res.set('Cache-Control', 'no-store');
  res.json({
    mode: 'project',
    version: project.targetVersion || 0,
    project: publicProject(project, false),
    targetUrl: `/ar/project/${project.scanToken}/targets.json?v=${encodeURIComponent(project.targetVersion || 0)}`,
  });
});

app.get('/api/public/upload/:token', async (req, res) => {
  const state = await readState();
  const project = state.projects.find(p => p.uploadToken === req.params.token);
  if (!project) return res.status(404).json({ error: 'Ссылка недействительна' });
  if (project.uploadUsedAt) return res.status(410).json({ error: 'Эта ссылка уже использована' });
  res.set('Cache-Control', 'no-store');
  res.json({ name: project.name, used: false });
});

app.post('/api/public/upload/:token', (req, res) => {
  upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'video', maxCount: 1 }])(req, res, async error => {
    if (error) return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: error.message });
    let photo, video;
    try {
      const state = await readState();
      const project = projectByUploadToken(state, req.params.token);
      photo = req.files?.photo?.[0];
      video = req.files?.video?.[0];
      if (!project) {
        await deleteItemFiles({ imagePath: photo?.filename, videoPath: video?.filename });
        return res.status(410).json({ error: 'Ссылка недействительна или уже использована' });
      }
      if (!photo || !video) {
        await deleteItemFiles({ imagePath: photo?.filename, videoPath: video?.filename });
        return res.status(400).json({ error: 'Нужно выбрать и фото, и видео' });
      }
      if (photo.size > MAX_IMAGE_BYTES) throw Object.assign(new Error(`Фото больше ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} МБ`), { statusCode: 413 });
      if (video.size > MAX_VIDEO_BYTES) throw Object.assign(new Error(`Видео больше ${Math.round(MAX_VIDEO_BYTES / 1024 / 1024)} МБ`), { statusCode: 413 });

      const image = await sharp(photo.path).metadata();
      const item = normalizeItem({
        id: id(),
        title: String(req.body.title || `Маркер ${project.items.length + 1}`).slice(0, 120),
        imagePath: photo.filename,
        videoPath: video.filename,
        width: image.width,
        height: image.height,
      }, project.id);
      project.items.push(item);
      project.uploadUsedAt = now();
      project.uploadToken = null;
      project.updatedAt = now();
      state.revision += 1;
      await writeState(state);
      broadcast('project-files-updated', { projectId: project.id, projectScanToken: project.scanToken });
      queueBuild('загрузка файлов пользователем');
      res.json({ ok: true, message: 'Файлы добавлены в проект. Спасибо!' });
    } catch (e) {
      await deleteItemFiles({ imagePath: photo?.filename, videoPath: video?.filename });
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });
});

app.get('/media/project/:scanToken/item/:itemId/:type', async (req, res) => {
  const state = await readState();
  const project = projectByScanToken(state, req.params.scanToken);
  const item = project?.items.find(x => x.id === req.params.itemId);
  if (!project || !item || !['image', 'video'].includes(req.params.type)) return res.status(404).send('Не найдено');
  const file = mediaForItem(project, item, req.params.type);
  if (!file) return res.status(404).send('Файл недоступен');
  sendMediaFile(res, file);
});

app.get('/ar/project/:scanToken/targets.json', async (req, res) => {
  const state = await readState();
  const project = projectByScanToken(state, req.params.scanToken);
  const target = project && project.enabled ? projectTargetPath(project) : null;
  if (!project || !projectReady(project) || !target || !(await exists(target))) return res.status(404).send('AR-база не готова');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.sendFile(target);
});
app.get('/ar/project/:scanToken/targets/:itemId/:file', async (req, res) => {
  const state = await readState();
  const project = projectByScanToken(state, req.params.scanToken);
  if (!project || !project.enabled || !project.items.some(item => item.id === req.params.itemId)) return res.sendStatus(404);
  if (!/^marker_(?:original|cropped|thumbnail|luminance)\.png$/.test(req.params.file)) return res.sendStatus(404);
  res.sendFile(path.join(TARGET_DIR, project.id, req.params.itemId, req.params.file));
});

// Admin auth
app.get('/api/admin/me', (req, res) => res.json({ authenticated: authenticated(req), user: ADMIN_USER }));
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username !== ADMIN_USER || password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Неверный логин или пароль' });
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL);
  setCookie(res, token);
  res.json({ ok: true });
});
app.post('/api/admin/logout', requireAdmin, (req, res) => {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  sessions.delete(token);
  clearCookie(res);
  res.json({ ok: true });
});

app.get('/api/admin/status', requireAdmin, async (_req, res) => {
  const state = await readState();
  res.json({ version: state.version, revision: state.revision, buildRunning, lastBuildError, commonReady: await exists(COMMON_TARGET) });
});

app.get('/api/admin/projects', requireAdmin, async (_req, res) => {
  const state = await readState();
  res.set('Cache-Control', 'no-store');
  res.json({ version: state.version, revision: state.revision, projects: state.projects.map(p => publicProject(p, true)) });
});

app.get('/api/admin/projects/:id', requireAdmin, async (req, res) => {
  const state = await readState();
  const project = state.projects.find(x => x.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Проект не найден' });
  res.set('Cache-Control', 'no-store');
  res.json({ version: state.version, project: publicProject(project, true) });
});

app.get('/api/admin/common-catalog', requireAdmin, async (_req, res) => {
  const state = await readState();
  const common = commonItems(state);
  const projects = common.map(({ project, item, targetIndex }) => ({
    ...publicItem(project, item, targetIndex),
    projectId: project.id,
    projectName: project.name,
  }));
  res.set('Cache-Control', 'no-store');
  res.json({ mode: 'common', version: state.version, projects, ready: await exists(COMMON_TARGET) && projects.length > 0, targetUrl: `/ar/common/targets.json?v=${encodeURIComponent(state.version)}` });
});

app.post('/api/admin/projects', requireAdmin, async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 120);
  if (!name) return res.status(400).json({ error: 'Введите имя/название проекта' });
  const state = await readState();
  const project = normalizeProject({ id: id(), name, scanToken: secret(), items: [], enabled: true, createdAt: now(), updatedAt: now() });
  state.projects.unshift(project);
  state.revision += 1;
  await writeState(state);
  broadcast('project-created', { projectId: project.id });
  res.json({ ok: true, project: publicProject(project, true) });
});

app.patch('/api/admin/projects/:id', requireAdmin, async (req, res) => {
  const state = await readState();
  const project = state.projects.find(x => x.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Проект не найден' });
  const name = String(req.body?.name ?? project.name).trim().slice(0, 120);
  if (!name) return res.status(400).json({ error: 'Название не может быть пустым' });
  project.name = name;
  project.updatedAt = now();
  state.revision += 1;
  await writeState(state);
  broadcast('project-updated', { projectId: project.id, projectScanToken: project.scanToken });
  res.json({ ok: true });
});

app.post('/api/admin/projects/:id/toggle', requireAdmin, async (req, res) => {
  const state = await readState();
  const project = state.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Проект не найден' });
  project.enabled = !project.enabled;
  project.updatedAt = now();
  state.revision += 1;
  await writeState(state);
  broadcast('project-updated', { projectId: project.id, projectScanToken: project.scanToken });
  queueBuild(project.enabled ? 'включение проекта' : 'отключение проекта');
  res.json({ ok: true, enabled: project.enabled });
});

app.delete('/api/admin/projects/:id', requireAdmin, async (req, res) => {
  const state = await readState();
  const index = state.projects.findIndex(p => p.id === req.params.id);
  if (index < 0) return res.status(404).json({ error: 'Проект не найден' });
  const project = state.projects[index];
  state.projects.splice(index, 1);
  state.revision += 1;
  await writeState(state);
  await deleteProjectFiles(project);
  broadcast('project-deleted', { projectId: project.id, projectScanToken: project.scanToken });
  queueBuild('удаление проекта');
  res.json({ ok: true });
});

app.post('/api/admin/projects/:id/items', requireAdmin, (req, res) => {
  upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'video', maxCount: 1 }])(req, res, async error => {
    if (error) return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: error.message });
    let photo, video;
    try {
      const state = await readState();
      const project = state.projects.find(p => p.id === req.params.id);
      photo = req.files?.photo?.[0];
      video = req.files?.video?.[0];
      if (!project) { await deleteItemFiles({ imagePath: photo?.filename, videoPath: video?.filename }); return res.status(404).json({ error: 'Проект не найден' }); }
      if (!photo || !video) { await deleteItemFiles({ imagePath: photo?.filename, videoPath: video?.filename }); return res.status(400).json({ error: 'Нужно загрузить и фото, и видео' }); }
      if (photo.size > MAX_IMAGE_BYTES) throw Object.assign(new Error(`Фото больше ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} МБ`), { statusCode: 413 });
      if (video.size > MAX_VIDEO_BYTES) throw Object.assign(new Error(`Видео больше ${Math.round(MAX_VIDEO_BYTES / 1024 / 1024)} МБ`), { statusCode: 413 });
      const image = await sharp(photo.path).metadata();
      const item = normalizeItem({
        title: String(req.body?.title || `Маркер ${project.items.length + 1}`).slice(0, 120),
        imagePath: photo.filename,
        videoPath: video.filename,
        width: image.width,
        height: image.height,
      }, project.id);
      project.items.push(item);
      project.updatedAt = now();
      state.revision += 1;
      await writeState(state);
      broadcast('project-files-updated', { projectId: project.id, projectScanToken: project.scanToken });
      queueBuild('добавление маркера администратором');
      res.json({ ok: true, item: publicItem(project, item, null) });
    } catch (e) {
      await deleteItemFiles({ imagePath: photo?.filename, videoPath: video?.filename });
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });
});

app.patch('/api/admin/projects/:projectId/items/:itemId', requireAdmin, (req, res) => {
  upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'video', maxCount: 1 }])(req, res, async error => {
    if (error) return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: error.message });
    let photo, video;
    try {
      const state = await readState();
      const project = state.projects.find(p => p.id === req.params.projectId);
      if (!project) return res.status(404).json({ error: 'Проект не найден' });
      const item = project.items.find(x => x.id === req.params.itemId);
      if (!item) return res.status(404).json({ error: 'Маркер не найден' });
      photo = req.files?.photo?.[0];
      video = req.files?.video?.[0];
      if (photo) {
        if (photo.size > MAX_IMAGE_BYTES) throw Object.assign(new Error('Фото превышает лимит'), { statusCode: 413 });
        const image = await sharp(photo.path).metadata();
        await fs.unlink(path.join(IMAGE_DIR, item.imagePath || '')).catch(() => {});
        item.imagePath = photo.filename;
        item.width = image.width;
        item.height = image.height;
      }
      if (video) {
        if (video.size > MAX_VIDEO_BYTES) throw Object.assign(new Error('Видео превышает лимит'), { statusCode: 413 });
        await fs.unlink(path.join(VIDEO_DIR, item.videoPath || '')).catch(() => {});
        item.videoPath = video.filename;
      }
      if (req.body?.title !== undefined) item.title = String(req.body.title).trim().slice(0, 120) || item.title;
      item.updatedAt = now();
      project.updatedAt = now();
      state.revision += 1;
      await writeState(state);
      broadcast('project-files-updated', { projectId: project.id, projectScanToken: project.scanToken });
      queueBuild('изменение маркера');
      res.json({ ok: true });
    } catch (e) {
      await deleteItemFiles({ imagePath: photo?.filename, videoPath: video?.filename });
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });
});

app.delete('/api/admin/projects/:projectId/items/:itemId', requireAdmin, async (req, res) => {
  const state = await readState();
  const project = state.projects.find(p => p.id === req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Проект не найден' });
  const idx = project.items.findIndex(x => x.id === req.params.itemId);
  if (idx < 0) return res.status(404).json({ error: 'Маркер не найден' });
  const item = project.items[idx];
  project.items.splice(idx, 1);
  project.updatedAt = now();
  state.revision += 1;
  await writeState(state);
  await deleteItemFiles(item);
  broadcast('project-files-updated', { projectId: project.id, projectScanToken: project.scanToken });
  queueBuild('удаление маркера');
  res.json({ ok: true });
});

app.post('/api/admin/project/:id/upload-link', requireAdmin, async (req, res) => {
  const state = await readState();
  const p = state.projects.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Проект не найден' });
  p.uploadToken = secret();
  p.uploadIssuedAt = now();
  p.uploadUsedAt = null;
  p.updatedAt = now();
  state.revision += 1;
  await writeState(state);
  const url = `/upload/${p.uploadToken}`;
  broadcast('project-updated', { projectId: p.id });
  res.json({ ok: true, url, token: p.uploadToken });
});

app.post('/api/admin/rebuild', requireAdmin, (_req, res) => { queueBuild('ручная пересборка'); res.json({ ok: true }); });

app.get('/ar/common/targets.json', requireAdmin, async (_req, res) => {
  if (!(await exists(COMMON_TARGET))) return res.status(404).send('AR-база ещё не готова');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.sendFile(COMMON_TARGET);
});
app.get('/ar/common/targets/:itemId/:file', requireAdmin, async (req, res) => {
  if (!/^marker_(?:original|cropped|thumbnail|luminance)\.png$/.test(req.params.file)) return res.sendStatus(404);
  res.sendFile(path.join(TARGET_DIR, 'common', req.params.itemId, req.params.file));
});

app.use('/vendor/xr', express.static(path.join(ROOT, 'node_modules/@8thwall/engine/dist')));
app.use('/vendor/three', express.static(path.join(ROOT, 'node_modules/three/build')));

app.get('/admin', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));
app.get('/scan', requireAdminPage, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'scan.html'), { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate' } }));
app.get('/scan/', (_req, res) => res.redirect('/scan'));
app.get('/scan/:scanToken', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'scan.html'), { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate' } }));
app.get('/upload/:token', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'upload.html')));
app.use((req, res, next) => {
  if (req.path.endsWith('.js') || req.path.endsWith('.css') || req.path.endsWith('.html')) res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  next();
});
app.use(express.static(PUBLIC_DIR, { extensions: ['html'], etag: false, lastModified: false, maxAge: 0 }));
app.get('/', (_req, res) => res.redirect('/scan'));
app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); });

async function syncStoredDimensions() {
  const state = await readState();
  let changed = false;
  for (const project of state.projects) {
    for (const item of project.items) {
      if (!item.imagePath) continue;
      try {
        const image = await sharp(path.join(IMAGE_DIR, item.imagePath)).metadata();
        if (image.width > 0 && image.height > 0 && (item.width !== image.width || item.height !== image.height)) {
          item.width = image.width;
          item.height = image.height;
          item.updatedAt = now();
          changed = true;
        }
      } catch (e) { console.warn(`[DIMENSIONS] ${project.name}/${item.title}: ${e.message}`); }
    }
  }
  if (changed) await writeState(state);
  return state;
}

const initialState = await syncStoredDimensions();
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
wss.on('connection', ws => {
  wsClients.add(ws);
  ws.send(JSON.stringify({ event: 'hello', version: initialState.version }));
  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', () => wsClients.delete(ws));
});

httpServer.listen(PORT, async () => {
  const state = await readState();
  globalThis.__arVersion = state.version;
  console.log('\nAR Photo Video Scanner v9');
  console.log(`Admin:      http://localhost:${PORT}/admin`);
  console.log(`Test scan:  http://localhost:${PORT}/scan`);
  console.log(`Projects:   /scan/<project-token>`);
  console.log(`Uploads:    /upload/<one-time-token>`);
  if (ADMIN_PASSWORD === 'change-me-now') console.warn('WARNING: смените ADMIN_PASSWORD в .env');
  const ready = state.projects.reduce((sum, p) => sum + readyItems(p).length, 0);
  if (ready > 0 && !(await exists(COMMON_TARGET))) queueBuild('восстановление AR-базы после запуска');
});
