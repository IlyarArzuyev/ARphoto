import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadImage } from 'canvas';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { OfflineCompiler } from 'mind-ar/src/image-target/offline-compiler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const IMAGE_DIR = path.join(MEDIA_DIR, 'images');
const VIDEO_DIR = path.join(MEDIA_DIR, 'videos');
const TARGET_FILE = path.join(DATA_DIR, 'targets.mind');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(ROOT, 'public');

const PORT = Number(process.env.PORT || 3000);
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-now';
const COOKIE_NAME = 'ar_admin';
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';
const MAX_VIDEO_BYTES = Number(process.env.MAX_VIDEO_BYTES || 524_288_000);
const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_BYTES || 20_971_520);

const sessions = new Map();
const wsClients = new Set();
let buildQueue = Promise.resolve();
let buildRunning = false;
let lastBuildError = null;

await Promise.all([
  fs.mkdir(IMAGE_DIR, { recursive: true }),
  fs.mkdir(VIDEO_DIR, { recursive: true }),
  fs.mkdir(PUBLIC_DIR, { recursive: true }),
]);

async function readState() {
  try {
    return JSON.parse(await fs.readFile(DB_FILE, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const initial = { version: 0, revision: 0, publishedIds: [], items: [] };
    await writeState(initial);
    return initial;
  }
}

async function writeState(state) {
  const tmp = `${DB_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(tmp, DB_FILE);
}

async function fileExists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

async function syncStoredImageDimensions() {
  const state = await readState();
  let changed = false;
  for (const item of state.items) {
    if (!item.imagePath) continue;
    try {
      const image = await loadImage(path.join(IMAGE_DIR, item.imagePath));
      const width = Number(image.width);
      const height = Number(image.height);
      if (width > 0 && height > 0 && (item.width !== width || item.height !== height)) {
        item.width = width;
        item.height = height;
        changed = true;
      }
    } catch (error) {
      console.warn(`[IMAGE DIMENSIONS] ${item.imagePath}: ${error.message}`);
    }
  }
  if (changed) await writeState(state);
}

function generateId() { return crypto.randomUUID(); }
function extFor(name, fallback) {
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
  const parts = [`${COOKIE_NAME}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${60 * 60 * 24 * 7}`];
  if (COOKIE_SECURE) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
function clearCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${COOKIE_SECURE ? '; Secure' : ''}`);
}
function authenticated(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  const expires = token && sessions.get(token);
  if (!expires || expires < Date.now()) { if (token) sessions.delete(token); return false; }
  return true;
}
function requireAdmin(req, res, next) {
  if (!authenticated(req)) return res.status(401).json({ error: 'Требуется вход в админку' });
  next();
}
function publicItem(item, targetIndex) {
  return {
    id: item.id,
    name: item.name,
    imageUrl: `/media/images/${item.imagePath}`,
    videoUrl: `/media/videos/${item.videoPath}`,
    width: item.width || 1,
    height: item.height || 1,
    targetIndex,
    updatedAt: item.updatedAt,
  };
}

const mediaStorage = multer.diskStorage({
  destination: (_req, file, cb) => cb(null, file.fieldname === 'photo' ? IMAGE_DIR : VIDEO_DIR),
  filename: (_req, file, cb) => cb(null, `${generateId()}${extFor(file.originalname, file.fieldname === 'photo' ? '.jpg' : '.mp4')}`),
});
const mediaUpload = multer({
  storage: mediaStorage,
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
  const message = JSON.stringify({ event, ...payload });
  for (const ws of wsClients) {
    try {
      if (ws.readyState === 1) ws.send(message);
    } catch {
      wsClients.delete(ws);
    }
  }
}

async function runBuild(reason = 'manual') {
  if (buildRunning) return;
  buildRunning = true;
  lastBuildError = null;
  let state = await readState();
  const startRevision = state.revision || 0;
  const enabled = state.items.filter(item => item.enabled);
  broadcast('build-start', { reason, count: enabled.length, revision: startRevision });

  try {
    if (!enabled.length) {
      await fs.unlink(TARGET_FILE).catch(() => {});
      state = await readState();
      if ((state.revision || 0) !== startRevision) {
        queueBuild('изменения во время сборки');
        return;
      }
      state.publishedIds = [];
      state.items.forEach(item => { item.targetIndex = null; item.published = false; });
      state.version += 1;
      await writeState(state);
      broadcast('build-progress', { progress: 100, text: 'AR-база очищена' });
      broadcast('ar-updated', { version: state.version, count: 0 });
      return;
    }

    const images = [];
    for (let index = 0; index < enabled.length; index++) {
      const item = enabled[index];
      const imagePath = path.join(IMAGE_DIR, item.imagePath);
      images.push(await loadImage(imagePath));
      broadcast('build-progress', { progress: Math.round(5 + (index / enabled.length) * 15), text: `Подготовка изображения ${index + 1} из ${enabled.length}` });
    }

    const compiler = new OfflineCompiler();
    const buffer = await compiler.compileImageTargets(images, progress => {
      const percent = Math.round(20 + progress * 0.75);
      broadcast('build-progress', { progress: percent, text: `Построение AR-базы: ${Math.round(progress)}%` });
    }).then(() => compiler.exportData());

    const latest = await readState();
    if ((latest.revision || 0) !== startRevision) {
      broadcast('build-progress', { progress: 100, text: 'Обнаружены новые изменения — повторяю сборку' });
      queueBuild('изменения во время сборки');
      return;
    }

    const dimensions = new Map(enabled.map((item, index) => [item.id, {
      width: Number(images[index].width),
      height: Number(images[index].height),
    }]));
    latest.items.forEach((item) => {
      const d = dimensions.get(item.id);
      if (d) {
        item.width = d.width;
        item.height = d.height;
      }
    });

    const tmpTarget = `${TARGET_FILE}.tmp`;
    await fs.writeFile(tmpTarget, buffer);
    await fs.rename(tmpTarget, TARGET_FILE);

    latest.publishedIds = enabled.map(item => item.id);
    const targetMap = new Map(latest.publishedIds.map((id, index) => [id, index]));
    latest.items.forEach(item => {
      item.targetIndex = targetMap.has(item.id) ? targetMap.get(item.id) : null;
      item.published = targetMap.has(item.id);
    });
    latest.version += 1;
    await writeState(latest);
    broadcast('build-progress', { progress: 100, text: 'Готово' });
    broadcast('ar-updated', { version: latest.version, count: latest.publishedIds.length });
  } catch (error) {
    console.error('[AR BUILD]', error);
    lastBuildError = error.message;
    broadcast('build-error', { error: error.message });
  } finally {
    buildRunning = false;
  }
}

function queueBuild(reason = 'change') {
  const run = buildQueue.then(() => runBuild(reason));
  buildQueue = run.catch(() => {});
  return run;
}

app.get('/api/public/catalog', async (_req, res) => {
  const state = await readState();
  const map = new Map(state.publishedIds.map((id, index) => [id, index]));
  const items = state.items.filter(item => item.enabled && map.has(item.id)).map(item => publicItem(item, map.get(item.id)));
  res.set('Cache-Control', 'no-store');
  res.json({ version: state.version, items, ready: await fileExists(TARGET_FILE) && items.length > 0 });
});

app.get('/api/events', (_req, res) => {
  res.status(410).json({ error: 'SSE отключён; используйте WebSocket /ws' });
});

app.get('/api/admin/me', (req, res) => res.json({ authenticated: authenticated(req), user: ADMIN_USER }));
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username !== ADMIN_USER || password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Неверный логин или пароль' });
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + 7 * 24 * 60 * 60 * 1000);
  setCookie(res, token);
  res.json({ ok: true });
});
app.post('/api/admin/logout', requireAdmin, (req, res) => {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME]; sessions.delete(token); clearCookie(res); res.json({ ok: true });
});

app.get('/api/admin/status', requireAdmin, async (_req, res) => {
  const state = await readState();
  res.json({ version: state.version, revision: state.revision, buildRunning, lastBuildError, targetFileReady: await fileExists(TARGET_FILE) });
});

app.get('/api/admin/items', requireAdmin, async (_req, res) => {
  const state = await readState();
  const map = new Map(state.publishedIds.map((id, index) => [id, index]));
  res.json({
    version: state.version,
    revision: state.revision,
    targetFileReady: await fileExists(TARGET_FILE),
    items: state.items.map(item => ({
      ...item,
      imageUrl: `/media/images/${item.imagePath}`,
      videoUrl: `/media/videos/${item.videoPath}`,
      targetIndex: map.has(item.id) ? map.get(item.id) : null,
      published: item.enabled && map.has(item.id),
    })),
  });
});

app.post('/api/admin/rebuild', requireAdmin, (_req, res) => {
  queueBuild('ручная пересборка');
  res.json({ ok: true, started: true });
});

app.post('/api/admin/items', requireAdmin, (req, res) => {
  mediaUpload.fields([{name:'photo',maxCount:1},{name:'video',maxCount:1}])(req, res, async error => {
    if (error) return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: error.message });
    let photo, video;
    try {
      photo = req.files?.photo?.[0]; video = req.files?.video?.[0];
      const name = String(req.body.name || '').trim();
      if (!name || !photo || !video) {
        if (photo?.path) await fs.unlink(photo.path).catch(()=>{}); if (video?.path) await fs.unlink(video.path).catch(()=>{});
        return res.status(400).json({ error: 'Введите название и выберите фото и видео' });
      }
      if (photo.size > MAX_IMAGE_BYTES) { await fs.unlink(photo.path).catch(()=>{}); await fs.unlink(video.path).catch(()=>{}); return res.status(413).json({error:`Фото слишком большое. Лимит ${Math.round(MAX_IMAGE_BYTES/1024/1024)} МБ`}); }
      if (video.size > MAX_VIDEO_BYTES) { await fs.unlink(photo.path).catch(()=>{}); await fs.unlink(video.path).catch(()=>{}); return res.status(413).json({error:`Видео слишком большое. Лимит ${Math.round(MAX_VIDEO_BYTES/1024/1024)} МБ`}); }
      const image = await loadImage(photo.path);
      const state = await readState();
      state.items.push({ id: generateId(), name: name.slice(0,120), imagePath: photo.filename, videoPath: video.filename, width:Number(image.width), height:Number(image.height), targetIndex:null, enabled:true, published:false, createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() });
      state.revision = (state.revision || 0) + 1;
      await writeState(state);
      queueBuild('добавление объекта');
      res.json({ ok:true, needsBuild:true });
    } catch (e) {
      if (photo?.path) await fs.unlink(photo.path).catch(()=>{}); if (video?.path) await fs.unlink(video.path).catch(()=>{});
      res.status(500).json({ error:e.message });
    }
  });
});

app.patch('/api/admin/items/:id', requireAdmin, (req, res) => {
  mediaUpload.fields([{name:'photo',maxCount:1},{name:'video',maxCount:1}])(req, res, async error => {
    if (error) return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error:error.message });
    try {
      const state=await readState(); const item=state.items.find(x=>x.id===req.params.id);
      if(!item) return res.status(404).json({error:'Объект не найден'});
      const photo=req.files?.photo?.[0]; const video=req.files?.video?.[0];
      const name=String(req.body.name ?? item.name).trim(); if(!name) return res.status(400).json({error:'Название не может быть пустым'});
      if(photo?.size>MAX_IMAGE_BYTES){await fs.unlink(photo.path).catch(()=>{});await fs.unlink(video?.path).catch(()=>{});return res.status(413).json({error:'Фото превышает лимит'});}
      if(video?.size>MAX_VIDEO_BYTES){await fs.unlink(photo?.path).catch(()=>{});await fs.unlink(video.path).catch(()=>{});return res.status(413).json({error:'Видео превышает лимит'});}
      let needsBuild=false;
      if(photo){
        const image = await loadImage(photo.path);
        const old=path.join(IMAGE_DIR,item.imagePath);
        item.imagePath=photo.filename;
        item.width=Number(image.width);
        item.height=Number(image.height);
        await fs.unlink(old).catch(()=>{});
        needsBuild=true;
      }
      if(video){const old=path.join(VIDEO_DIR,item.videoPath);item.videoPath=video.filename;await fs.unlink(old).catch(()=>{});}
      item.name=name.slice(0,120);item.updatedAt=new Date().toISOString();
      state.revision=(state.revision||0)+1; await writeState(state);
      if(needsBuild) queueBuild('замена фото');
      else { state.version += 1; await writeState(state); broadcast('catalog-updated',{version:state.version}); }
      res.json({ok:true,needsBuild});
    } catch(e){res.status(500).json({error:e.message});}
  });
});

app.post('/api/admin/items/:id/toggle', requireAdmin, async (req,res)=>{
  try{const state=await readState();const item=state.items.find(x=>x.id===req.params.id);if(!item)return res.status(404).json({error:'Объект не найден'});item.enabled=!item.enabled;item.updatedAt=new Date().toISOString();state.revision=(state.revision||0)+1;await writeState(state);queueBuild(item.enabled?'включение объекта':'отключение объекта');res.json({ok:true,enabled:item.enabled,needsBuild:true});}
  catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/admin/measure', requireAdmin, async (req,res)=>{
  try{const {id:itemId,width,height}=req.body||{};const state=await readState();const item=state.items.find(x=>x.id===itemId);if(!item)return res.status(404).json({error:'Объект не найден'});const w=Number(width),h=Number(height);if(!(w>0&&h>0))return res.status(400).json({error:'Некорректный размер'});item.width=Math.round(w);item.height=Math.round(h);await writeState(state);res.json({ok:true});}
  catch(e){res.status(500).json({error:e.message});}
});

app.use('/media/images', express.static(IMAGE_DIR, { maxAge:'1h', etag:true, fallthrough:false }));
app.use('/media/videos', express.static(VIDEO_DIR, {
  maxAge: 0,
  etag: true,
  fallthrough: false,
  setHeaders: (res) => {
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  }
}));
app.get('/ar/targets.mind', async (_req,res)=>{if(!(await fileExists(TARGET_FILE)))return res.status(404).send('AR база ещё не готова');res.set('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');res.sendFile(TARGET_FILE);});

// Self-host the libraries from node_modules so the public scanner can work without external CDNs.
app.use('/vendor/aframe', express.static(path.join(ROOT,'node_modules/aframe/dist')));
app.use('/vendor/mind-ar', express.static(path.join(ROOT,'node_modules/mind-ar/dist')));
app.use(express.static(PUBLIC_DIR, { extensions:['html'] }));
app.get('/admin', (_req,res)=>res.sendFile(path.join(PUBLIC_DIR,'admin.html')));
app.get('/scan', (_req,res)=>res.sendFile(path.join(PUBLIC_DIR,'scan.html')));
app.get('/', (_req,res)=>res.redirect('/scan'));

app.use((err,_req,res,_next)=>{console.error(err);res.status(500).json({error:'Ошибка сервера'});});

await syncStoredImageDimensions();

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
wss.on('connection', (ws) => {
  wsClients.add(ws);
  try { ws.send(JSON.stringify({ event: 'connected', version: currentStateVersionSafe() })); } catch {}
  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', () => wsClients.delete(ws));
});

function currentStateVersionSafe() {
  return 0;
}

httpServer.listen(PORT,'0.0.0.0',()=>{
  console.log(`\nAR Photo Video Scanner`);
  console.log(`Admin:     http://localhost:${PORT}/admin`);
  console.log(`Scanner:   http://localhost:${PORT}/scan`);
  console.log(`WebSocket: ws://localhost:${PORT}/ws`);
  if (ADMIN_PASSWORD === 'change-me-now') console.warn('WARNING: смените ADMIN_PASSWORD в .env');
});
