const headers = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
};

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

async function authorized(request, secret) {
  const match = /^Basic ([A-Za-z0-9+/=]+)$/i.exec(request.headers.get('Authorization') || '');
  if (!match) return false;
  let credentials;
  try { credentials = atob(match[1]); } catch { return false; }
  const encoder = new TextEncoder();
  const digest = async value => new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  const [given, expected] = await Promise.all([digest(credentials), digest('planner:' + secret)]);
  let mismatch = 0;
  for (let i = 0; i < given.length; i++) mismatch |= given[i] ^ expected[i];
  return mismatch === 0;
}

function field(value, max, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    fail(400, 'Проверьте заполнение полей.');
  }
  return value.trim();
}

function date(value) {
  if (value === '') return '';
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(400, 'Некорректная дата.');
  const parsed = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(+parsed) || parsed.toISOString().slice(0, 10) !== value) fail(400, 'Некорректная дата.');
  return value;
}

function boolean(value) {
  if (typeof value !== 'boolean') fail(400, 'Некорректный статус.');
  return value;
}

function revision(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail(400, 'Некорректная версия записи.');
  return value;
}

function parseTask(body) {
  if (!Array.isArray(body.steps) || body.steps.length > 50) fail(400, 'Можно добавить до 50 подзадач.');
  const planned = date(body.planned);
  const time = body.time;
  const endTime = body.endTime;
  const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  if (typeof time !== 'string' || typeof endTime !== 'string' ||
      (time && (!planned || !clock.test(time))) ||
      (endTime && (!time || !clock.test(endTime) || endTime <= time))) {
    fail(400, 'Укажите дату и проверьте время начала и окончания.');
  }
  if (body.kind !== 'task' && body.kind !== 'event') fail(400, 'Некорректный тип записи.');
  if (body.kind === 'event' && !planned) fail(400, 'Укажите дату события.');
  const sectionId = body.sectionId === null ? null : field(body.sectionId, 36, true);
  const task = {
    title: field(body.title, 160, true), notes: field(body.notes, 4000),
    kind: body.kind, planned, deadline: date(body.deadline), time, endTime,
    done: boolean(body.done),
    steps: body.steps.map(step => {
      if (!step || typeof step !== 'object') fail(400, 'Некорректная подзадача.');
      return { title: field(step.title, 160, true), done: boolean(step.done), planned: date(step.planned) };
    })
  };
  return { sectionId, task };
}

async function readBody(request, url) {
  if (request.headers.get('Origin') !== url.origin ||
      !/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type') || '')) {
    fail(403, 'Запрос отклонён.');
  }
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'Пустой запрос.');
  const decoder = new TextDecoder();
  let raw = '';
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 65536) {
      await reader.cancel();
      fail(413, 'Запрос слишком большой.');
    }
    raw += decoder.decode(value, { stream: true });
  }
  let body;
  try { body = JSON.parse(raw + decoder.decode()); } catch { fail(400, 'Некорректный JSON.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Некорректные данные.');
  return body;
}

export function createApp({ store, secret, assets }) {
  return async request => {
    const url = new URL(request.url);
    const json = (data, status = 200) => Response.json(data, { status, headers });
    if (!secret || !/^[A-Za-z0-9_-]{24,128}$/.test(secret)) {
      return json({ error: 'Настройте PLANNER_PASSWORD перед запуском.' }, 503);
    }
    if (!(await authorized(request, secret))) {
      return new Response('Войдите в ежедневник.', {
        status: 401,
        headers: { ...headers, 'WWW-Authenticate': 'Basic realm="RSA Planner", charset="UTF-8"' }
      });
    }
    const { pathname } = url;
    const { method } = request;
    try {
      if (!pathname.startsWith('/api/')) {
        if (method !== 'GET' && method !== 'HEAD') return json({ error: 'Метод недоступен.' }, 405);
        const asset = await assets(request);
        const merged = new Headers(asset.headers);
        for (const [key, value] of Object.entries(headers)) merged.set(key, value);
        return new Response(asset.body, { status: asset.status, headers: merged });
      }
      if (method === 'GET' && (pathname === '/api/state' || pathname === '/api/export')) {
        return json({ version: 1, ...(await store.snapshot()) });
      }
      const match = /^\/api\/(tasks|sections)(?:\/([a-f0-9-]{36}))?$/.exec(pathname);
      if (!match) return json({ error: 'Страница не найдена.' }, 404);
      const [, collection, id] = match;
      const write = (!id && method === 'POST') || (id && method === 'PUT');
      const remove = collection === 'tasks' && id && method === 'DELETE';
      if (!write && !remove) return json({ error: 'Метод недоступен.' }, 405);
      const body = await readBody(request, url);
      if (collection === 'sections') {
        const name = field(body.name, 48, true);
        if (!['blue', 'green', 'violet', 'orange', 'pink'].includes(body.color)) fail(400, 'Выберите цвет.');
        if (!await store.saveSection(id, { name, color: body.color })) fail(404, 'Раздел не найден.');
      } else if (remove) {
        if (!await store.deleteTask(id, revision(body.revision))) fail(409, 'Запись уже изменилась. Закройте карточку и откройте её снова.');
      } else {
        const { sectionId, task } = parseTask(body);
        if (!await store.saveTask(id, id ? revision(body.revision) : null, sectionId, task)) {
          fail(409, 'Запись уже изменилась. Закройте карточку и откройте её снова.');
        }
      }
      return json({ ok: true }, method === 'POST' ? 201 : 200);
    } catch (error) {
      if (error.status) return json({ error: error.message }, error.status);
      if (String(error.message).includes('FOREIGN KEY constraint failed')) {
        return json({ error: 'Раздел не найден.' }, 400);
      }
      return json({ error: 'Ошибка сохранения или загрузки. Попробуйте ещё раз.' }, 500);
    }
  };
}
