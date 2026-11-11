const $ = id => document.getElementById(id);
const fullDate = new Intl.DateTimeFormat('ru', { dateStyle: 'full' });
const monthName = new Intl.DateTimeFormat('ru', { month: 'long', year: 'numeric' });
const shortDate = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short' });
const localDate = value => new Date(value + 'T12:00:00');
const dayKey = (date = new Date()) => [
  String(date.getFullYear()).padStart(4, '0'),
  String(date.getMonth() + 1).padStart(2, '0'),
  String(date.getDate()).padStart(2, '0')
].join('-');
function shift(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}
const monday = date => shift(date, -(date.getDay() + 6) % 7);
let selected = dayKey();
let mode = matchMedia('(max-width: 740px)').matches ? 'day' : 'month';
let view = 'calendar';
let snapshot = { sections: [], tasks: [] };
let currentTask;
let currentSection;
let requestVersion = 0;
let ready = false;
let calendarDrag;
let calendarSaving = false;
const taskDialog = $('task-dialog');
const taskForm = $('task-form');
const sectionDialog = $('section-dialog');
const sectionForm = $('section-form');

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(text, action, className) {
  const node = element('button', text, className);
  node.type = 'button';
  node.onclick = action;
  return node;
}

async function api(path, method = 'GET', data) {
  const response = await fetch('/api/' + path, {
    method, cache: 'no-store',
    ...(data && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
  });
  if (!response.headers.get('Content-Type')?.includes('application/json')) {
    throw new Error(response.status === 401 ? 'Нужно войти в ежедневник.' : 'Сервер вернул неожиданный ответ.');
  }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Запрос не выполнен.');
  return result;
}

async function refresh() {
  if (calendarDrag || calendarSaving) return;
  const version = ++requestVersion;
  try {
    const result = await api('state');
    if (version !== requestVersion || calendarDrag || calendarSaving) return;
    snapshot = result;
    ready = true;
    $('status').textContent = '';
    render();
  } catch (error) {
    if (version === requestVersion) $('status').textContent = 'Не удалось обновить данные. ' + error.message;
  }
}

function sectionOf(id) {
  return snapshot.sections.find(section => section.id === id);
}

function options(select, first) {
  const previous = select.value;
  select.replaceChildren(new Option(first, ''), ...snapshot.sections.map(s => new Option(s.name, s.id)));
  if (sectionOf(previous)) select.value = previous;
}

function entry(task, step) {
  const record = step || task;
  const section = sectionOf(task.sectionId);
  const title = step ? step.title : task.title;
  const item = button('', () => openTask(task), 'entry' + (record.done ? ' done' : ''));
  const dateInfo = [
    record.planned && shortDate.format(localDate(record.planned)),
    !step && task.time && (task.endTime ? task.time + '–' + task.endTime : task.time),
    !step && task.deadline && 'до ' + shortDate.format(localDate(task.deadline)),
    step ? 'Подзадача · ' + task.title : task.kind === 'event' ? 'Событие' : 'Задача',
    section?.name
  ].filter(Boolean).join(' · ');
  const text = element('span');
  text.append(element('strong', title, 'entry-title'), element('small', dateInfo));
  item.append(element('i', '', 'dot ' + (section?.color || '')), text);
  return item;
}

function chronological(a, b) {
  return (a.planned || '9999').localeCompare(b.planned || '9999') ||
    a.time.localeCompare(b.time) || a.title.localeCompare(b.title, 'ru');
}

function renderList() {
  const search = $('search').value.trim().toLocaleLowerCase('ru');
  const sectionId = view === 'all' ? $('filter-section').value : view;
  const status = $('filter-status').value;
  const dateFilter = $('filter-date').value;
  const tasks = snapshot.tasks.filter(task =>
    (!sectionId || task.sectionId === sectionId) &&
    (!status || task.done === (status === 'done')) &&
    (!dateFilter || Boolean(task.planned) === (dateFilter === 'scheduled')) &&
    (!search || task.title.toLocaleLowerCase('ru').includes(search))
  ).sort(chronological);
  $('list-items').replaceChildren(...(tasks.length ? tasks.map(task => entry(task)) : [element('p', 'Здесь пока нет записей.', 'empty')]));
}


function clearCalendarDrag() {
  calendarDrag = undefined;
  for (const node of document.querySelectorAll('.dragging, .drop-target')) {
    node.classList.remove('dragging', 'drop-target');
  }
}

function makeCalendarDraggable(node, task, step) {
  node.draggable = !calendarSaving;
  node.addEventListener('dragstart', event => {
    if (calendarSaving) {
      event.preventDefault();
      return;
    }
    calendarDrag = { task, stepIndex: step ? task.steps.indexOf(step) : -1 };
    requestVersion++;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', task.id);
    node.classList.add('dragging');
  });
  node.addEventListener('dragend', clearCalendarDrag);
}

async function moveCalendarRecord(drag, planned) {
  const { task, stepIndex } = drag;
  const original = stepIndex < 0 ? task : task.steps[stepIndex];
  if (calendarSaving || original.planned === planned) return;
  const updated = { ...task };
  if (stepIndex < 0) updated.planned = planned;
  else updated.steps = task.steps.map((step, index) => index === stepIndex ? { ...step, planned } : step);
  calendarSaving = true;
  requestVersion++;
  $('status').textContent = 'Сохранение новой даты…';
  let failure;
  try {
    await api('tasks/' + task.id, 'PUT', updated);
  } catch (error) {
    failure = error;
  } finally {
    calendarSaving = false;
  }
  await refresh();
  if (failure) {
    $('status').textContent = 'Не удалось подтвердить перенос. ' + failure.message;
  }
}

function makeCalendarDropTarget(cell, planned) {
  cell.addEventListener('dragover', event => {
    if (!calendarDrag || calendarSaving) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    cell.classList.add('drop-target');
  });
  cell.addEventListener('dragleave', event => {
    if (!cell.contains(event.relatedTarget)) cell.classList.remove('drop-target');
  });
  cell.addEventListener('drop', event => {
    if (!calendarDrag || calendarSaving) return;
    event.preventDefault();
    const drag = calendarDrag;
    clearCalendarDrag();
    moveCalendarRecord(drag, planned);
  });
}

function renderCalendar() {
  const date = localDate(selected);
  const start = mode === 'month' ? monday(new Date(date.getFullYear(), date.getMonth(), 1, 12)) : monday(date);
  const days = mode === 'month' ? 42 : 7;
  const byDate = new Map();
  function add(key, value) {
    if (!key) return;
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(value);
  }
  for (const task of [...snapshot.tasks].sort(chronological)) {
    add(task.planned, { task });
    for (const step of task.steps) add(step.planned, { task, step });
  }
  $('period').textContent = mode === 'month' ? monthName.format(date) : mode === 'week'
    ? shortDate.format(start) + ' — ' + shortDate.format(shift(start, 6)) : fullDate.format(date);
  $('agenda-title').textContent = mode === 'day' ? 'Записи на день' : fullDate.format(date);
  const grid = $('grid');
  grid.hidden = mode === 'day';
  grid.className = 'calendar-grid';
  grid.replaceChildren();
  if (mode !== 'day') {
    for (const day of ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']) grid.append(element('div', day, 'weekday'));
    for (let index = 0; index < days; index++) {
      const cellDate = shift(start, index);
      const key = dayKey(cellDate);
      const records = byDate.get(key) || [];
      const cell = element('div', '', 'day');
      makeCalendarDropTarget(cell, key);
      cell.classList.toggle('outside', mode === 'month' && cellDate.getMonth() !== date.getMonth());
      cell.classList.toggle('selected', selected === key);
      const pick = button(String(cellDate.getDate()), () => {
        selected = key;
        renderCalendar();
        $('grid').querySelector('[data-date="' + key + '"]')?.focus();
      }, 'day-number');
      pick.dataset.date = key;
      pick.setAttribute('aria-label', fullDate.format(cellDate) + (records.length ? ', записей: ' + records.length : ''));
      pick.setAttribute('aria-pressed', String(selected === key));
      if (dayKey() === key) pick.setAttribute('aria-current', 'date');
      cell.append(pick);
      for (const { task, step } of records.slice(0, 2)) {
        const record = step || task;
        const label = (!step && task.time ? task.time + ' ' : '') + record.title;
        const section = sectionOf(task.sectionId);
        const chip = button(
          label,
          () => openTask(task),
          'chip ' + (section?.color || '') + (record.done ? ' done' : '')
        );
        chip.title = label;
        makeCalendarDraggable(chip, task, step);
        cell.append(chip);
      }
      if (records.length > 2) cell.append(element('small', 'Ещё ' + (records.length - 2), 'more'));
      if (records.length) cell.append(element('span', String(records.length), 'day-count'));
      grid.append(cell);
    }
  }
  const dayRecords = byDate.get(selected) || [];
  $('agenda-list').replaceChildren(...(dayRecords.length
    ? dayRecords.map(({ task, step }) => {
      const item = entry(task, step);
      makeCalendarDraggable(item, task, step);
      return item;
    })
    : [element('p', 'На этот день ничего не запланировано.', 'empty')]));
  for (const control of $('modes').querySelectorAll('button')) {
    control.setAttribute('aria-pressed', String(control.dataset.mode === mode));
  }
}

function render() {
  const section = sectionOf(view);
  $('today-label').textContent = fullDate.format(new Date());
  $('heading').textContent = section?.name || (view === 'calendar' ? 'Календарь' : 'Все записи');
  $('calendar').hidden = view !== 'calendar';
  $('list').hidden = view === 'calendar';
  $('edit-section').hidden = !section;
  $('filter-section').hidden = view !== 'all';
  $('new-task').disabled = !ready;
  $('add-day').disabled = !ready;
  $('sections').replaceChildren(...snapshot.sections.map(item => {
    const node = button('', () => show(item.id));
    node.dataset.view = item.id;
    node.append(element('i', '', 'dot ' + item.color), document.createTextNode(item.name));
    return node;
  }));
  for (const control of document.querySelectorAll('[data-view]')) {
    if (control.dataset.view === view) control.setAttribute('aria-current', 'page');
    else control.removeAttribute('aria-current');
  }
  options($('filter-section'), 'Все разделы');
  if (view === 'calendar') renderCalendar();
  else renderList();
}

function show(next) {
  view = next;
  $('search').value = '';
  $('filter-status').value = '';
  $('filter-date').value = '';
  $('filter-section').value = '';
  render();
}

function move(direction) {
  const date = localDate(selected);
  if (mode === 'month') {
    const first = new Date(date.getFullYear(), date.getMonth() + direction, 1, 12);
    const last = new Date(first.getFullYear(), first.getMonth() + 1, 0, 12);
    first.setDate(Math.min(date.getDate(), last.getDate()));
    selected = dayKey(first);
  } else selected = dayKey(shift(date, direction * (mode === 'week' ? 7 : 1)));
  renderCalendar();
}

function addStep(step = {}) {
  if ($('steps').children.length >= 50) return;
  const row = element('div', '', 'step');
  const done = element('input');
  done.type = 'checkbox';
  done.checked = step.done || false;
  done.setAttribute('aria-label', 'Подзадача завершена');
  const title = element('input');
  title.required = true;
  title.maxLength = 160;
  title.placeholder = 'Подзадача';
  title.value = step.title || '';
  title.setAttribute('aria-label', 'Название подзадачи');
  const planned = element('input');
  planned.type = 'date';
  planned.value = step.planned || '';
  planned.setAttribute('aria-label', 'Дата подзадачи');
  const remove = button('×', () => row.remove());
  remove.setAttribute('aria-label', 'Удалить подзадачу');
  row.append(done, title, planned, remove);
  $('steps').append(row);
  return title;
}

function openTask(task, defaults = {}) {
  currentTask = task;
  taskForm.reset();
  options(taskForm.elements.sectionId, 'Без раздела');
  const values = task || defaults;
  for (const key of ['title', 'kind', 'sectionId', 'planned', 'deadline', 'time', 'endTime', 'notes']) {
    if (values[key]) taskForm.elements[key].value = values[key];
  }
  taskForm.elements.done.checked = task?.done || false;
  $('steps').replaceChildren();
  task?.steps.forEach(addStep);
  $('task-heading').textContent = task ? 'Редактировать запись' : 'Новая запись';
  $('delete-task').hidden = !task;
  taskForm.querySelector('.error').textContent = '';
  taskDialog.showModal();
  taskForm.elements.title.focus();
}

function openSection(section) {
  currentSection = section;
  sectionForm.reset();
  $('section-heading').textContent = section ? 'Настройки раздела' : 'Новый раздел';
  if (section) {
    sectionForm.elements.name.value = section.name;
    sectionForm.elements.color.value = section.color;
  }
  sectionForm.querySelector('.error').textContent = '';
  sectionDialog.showModal();
}

async function submit(form, action) {
  if (form.dataset.busy) return;
  form.dataset.busy = 'true';
  const controls = [...form.querySelectorAll('button')].filter(control => !control.disabled);
  controls.forEach(control => { control.disabled = true; });
  const dialog = form.closest('dialog');
  const error = form.querySelector('.error');
  error.textContent = '';
  try {
    await action();
    dialog.close();
    await refresh();
  } catch (failure) {
    error.textContent = failure.message;
    await refresh();
  } finally {
    delete form.dataset.busy;
    controls.forEach(control => { control.disabled = false; });
  }
}

taskForm.onsubmit = event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(taskForm));
  data.sectionId ||= null;
  data.done = taskForm.elements.done.checked;
  data.steps = [...$('steps').children].map(row => {
    const [done, title, planned] = row.querySelectorAll('input');
    return { done: done.checked, title: title.value, planned: planned.value };
  });
  if (currentTask) data.revision = currentTask.revision;
  submit(taskForm, () => currentTask ? api('tasks/' + currentTask.id, 'PUT', data) : api('tasks', 'POST', data));
};
$('delete-task').onclick = () => {
  if (confirm('Удалить запись вместе с подзадачами?')) {
    submit(taskForm, () => api('tasks/' + currentTask.id, 'DELETE', { revision: currentTask.revision }));
  }
};
sectionForm.onsubmit = event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(sectionForm));
  submit(sectionForm, () => currentSection ? api('sections/' + currentSection.id, 'PUT', data) : api('sections', 'POST', data));
};

for (const dialog of [taskDialog, sectionDialog]) {
  dialog.querySelector('[data-close]').onclick = () => dialog.close();
  dialog.addEventListener('cancel', event => {
    if (dialog.querySelector('form').dataset.busy) event.preventDefault();
  });
}
for (const control of document.querySelectorAll('[data-view]')) control.onclick = () => show(control.dataset.view);
for (const control of $('modes').querySelectorAll('button')) control.onclick = () => {
  mode = control.dataset.mode;
  renderCalendar();
};
for (const id of ['search', 'filter-status', 'filter-date', 'filter-section']) $(id).oninput = renderList;
$('new-task').onclick = () => openTask(null, {
  planned: view === 'calendar' ? selected : '', sectionId: sectionOf(view)?.id
});
$('add-day').onclick = () => openTask(null, { planned: selected });
$('new-section').onclick = () => openSection();
$('edit-section').onclick = () => openSection(sectionOf(view));
$('add-step').onclick = () => addStep()?.focus();
$('prev').onclick = () => move(-1);
$('next').onclick = () => move(1);
$('today').onclick = () => {
  selected = dayKey();
  renderCalendar();
};
$('export').onclick = async () => {
  try {
    const data = await api('export');
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const link = element('a');
    link.href = url;
    link.download = 'rsaplanner-' + dayKey() + '.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch (error) {
    $('status').textContent = error.message;
  }
};
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
window.addEventListener('focus', refresh);
window.addEventListener('online', refresh);
refresh();
