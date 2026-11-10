import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createApp } from '../src/api.mjs';
import { createStore } from '../src/store.mjs';
import worker from '../src/worker.mjs';

const origin = 'https://planner.example';
const secret = 'local_test_password_long_enough';
const auth = 'Basic ' + btoa('planner:' + secret);

function fixture(t, useWorker) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
  const assets = () => new Response('Planner');
  const store = createStore({
    all: (sql, ...values) => db.prepare(sql).all(...values),
    run: (sql, ...values) => db.prepare(sql).run(...values).changes
  });
  const app = useWorker ? request => worker.fetch(request, {
    PLANNER_PASSWORD: secret, ASSETS: { fetch: assets },
    DB: { prepare: sql => ({ bind: (...values) => ({
      all: () => ({ results: db.prepare(sql).all(...values) }),
      run: () => ({ meta: db.prepare(sql).run(...values) })
    }) }) }
  }) : createApp({ store, secret, assets });
  return (path, method = 'GET', data, extra = {}) => app(new Request(origin + path, {
    method,
    headers: { Authorization: auth, Origin: origin, 'Content-Type': 'application/json', ...extra },
    body: data && JSON.stringify(data)
  }));
}

const task = {
  title: 'Подготовить договор', notes: 'Проверить реквизиты', kind: 'task',
  planned: '2026-11-14', deadline: '2026-11-17', time: '11:00', endTime: '12:00',
  done: false, steps: [{ title: 'Проверить приложения', planned: '2026-11-13', done: true }]
};

for (const useWorker of [false, true]) {
  const runtime = useWorker ? 'Worker binding' : 'SQLite';
  test(runtime + ' protects site and API, rejects cross-origin writes', async t => {
    const call = fixture(t, useWorker);
    assert.equal((await call('/', 'GET', undefined, { Authorization: '' })).status, 401);
    assert.equal((await call('/api/export', 'GET', undefined, { Authorization: 'Basic eDp5' })).status, 401);
    assert.equal((await call('/')).headers.get('Cache-Control'), 'no-store');
    assert.equal((await call('/api/sections', 'POST', { name: 'Работа', color: 'blue' }, { Origin: 'https://other.example' })).status, 403);
  });

  test(runtime + ' persists sections, tasks, events and detects stale edits', async t => {
    const call = fixture(t, useWorker);
    assert.equal((await call('/api/sections', 'POST', { name: 'Работа', color: 'blue' })).status, 201);
    const initial = await (await call('/api/state')).json();
    const [{ id: sectionId }] = initial.sections;
    assert.equal((await call('/api/tasks', 'POST', { ...task, planned: '2026-02-30', sectionId })).status, 400);
    assert.equal((await call('/api/tasks', 'POST', { ...task, sectionId: crypto.randomUUID() })).status, 400);
    assert.equal((await call('/api/tasks', 'POST', { ...task, sectionId })).status, 201);
    assert.equal((await call('/api/tasks', 'POST', { ...task, kind: 'event', planned: '', time: '', endTime: '', sectionId: null })).status, 400);
    assert.equal((await call('/api/tasks', 'POST', { ...task, kind: 'event', sectionId: null })).status, 201);
    const exported = await (await call('/api/export')).json();
    const saved = exported.tasks.find(item => item.kind === 'task');
    assert.deepEqual(saved.steps, task.steps);
    const path = '/api/tasks/' + saved.id;
    assert.equal((await call(path, 'PUT', { ...saved, planned: '2026-11-15' })).status, 200);
    assert.equal((await call(path, 'PUT', saved)).status, 409);
    assert.equal((await call(path, 'DELETE', { revision: 1 })).status, 409);
    assert.equal((await call(path, 'DELETE', { revision: 2 })).status, 200);
    assert.equal((await (await call('/api/state')).json()).tasks.length, 1);
  });
}
