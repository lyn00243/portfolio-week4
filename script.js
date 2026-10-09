// Personal website — shared interactivity

// Mobile menu toggle
const menuBtn = document.getElementById('menuBtn');
const mobileMenu = document.getElementById('mobileMenu');
if (menuBtn && mobileMenu) {
  menuBtn.addEventListener('click', () => mobileMenu.classList.toggle('open'));
  mobileMenu.querySelectorAll('a').forEach(a =>
    a.addEventListener('click', () => mobileMenu.classList.remove('open'))
  );
}

// Scroll reveal via IntersectionObserver
const revealEls = document.querySelectorAll('.reveal');
if (revealEls.length) {
  const io = new IntersectionObserver(
    entries => {
      entries.forEach(e => {
        if (e.isIntersecting) {
          e.target.classList.add('in-view');
          io.unobserve(e.target);
        }
      });
    },
    { threshold: 0.12 }
  );
  revealEls.forEach(el => io.observe(el));
}

// Contact form — friendly fake submit
const form = document.getElementById('contactForm');
const formMsg = document.getElementById('formMsg');
if (form && formMsg) {
  form.addEventListener('submit', e => {
    e.preventDefault();
    form.reset();
    formMsg.classList.add('show');
  });
}

// ===== To-do planner (Projects page) =====
(function () {
  const todoForm = document.getElementById('todoForm');
  if (!todoForm) return;

  const calGrid = document.getElementById('calGrid');
  const calTitle = document.getElementById('calTitle');
  const calPrev = document.getElementById('calPrev');
  const calNext = document.getElementById('calNext');
  const todoInput = document.getElementById('todoInput');
  const todoList = document.getElementById('todoList');
  const todoEmpty = document.getElementById('todoEmpty');
  const todoDateDisplay = document.getElementById('todoDateDisplay');
  const todoTags = document.getElementById('todoTags');
  const todoCount = document.getElementById('todoCount');
  const todoCountText = document.getElementById('todoCountText');
  const todoProgressBar = document.getElementById('todoProgressBar');
  const todoError = document.getElementById('todoError');

  // --- Persistence: Supabase primary, localStorage fallback ---
  // Supabase is the primary store. When a Supabase call fails (the todos
  // table schema is currently broken: done/tag/text/created_at missing),
  // we fall back to localStorage so the app keeps working and no tasks
  // are lost. Once the table is fixed, writes succeed against Supabase
  // automatically. localStorage stays in sync as a mirror/fallback.
  const SUPABASE_URL = 'https://keksxtnrjwcsqagyrlqe.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_o9mwEyLpfWl5T3_bBrivdg_z4rarCDB';
  const TABLE = 'todos';
  const STORE_KEY = 'lin-todo-v2';
  let supa = null;
  if (window.supabase && typeof window.supabase.createClient === 'function') {
    try { supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY); }
    catch (e) { console.error('Supabase init failed:', e); supa = null; }
  }

  let tasks = [];
  let errorTimer = null;
  function showError(msg) {
    if (!todoError) return;
    todoError.textContent = msg;
    todoError.hidden = false;
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => { todoError.hidden = true; }, 4000);
  }

  // --- localStorage fallback helpers ---
  function loadStore() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }
  function saveStore(rows) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(rows)); }
    catch (e) { console.error('Save to localStorage failed:', e); }
  }
  function genId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
  }
  function sortByDate(a, b) {
    const d = String(a.date).localeCompare(String(b.date));
    if (d !== 0) return d;
    const aT = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bT = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return aT - bT;
  }

  // --- Supabase <-> app shape mapping (real table columns) ---
  // Real table: id(int), task(text), is_complete(bool), date(date),
  //             create_at(timestamptz), priority(text), emoji(text)
  // App shape:  id, text, date, done, tag({kind,value}|null), createdAt
  // NOTE: the `emoji` column has a bad DEFAULT ('"::text'); we always set
  // emoji explicitly on insert/update so the broken default never fires.
  const BROKEN_EMOJI_DEFAULT = '"::text';
  function tagFromRow(priority, emoji) {
    const pri = (priority == null || priority === '') ? null : priority;
    if (pri) return { kind: 'pri', value: pri };
    const emo = (emoji == null || emoji === '' || emoji === BROKEN_EMOJI_DEFAULT) ? null : emoji;
    if (emo) return { kind: 'emoji', value: emo };
    return null;
  }
  function fromRow(r) {
    return {
      id: r.id,
      text: r.task,
      date: typeof r.date === 'string' ? r.date : isoDate(new Date(r.date)),
      done: !!r.is_complete,
      tag: tagFromRow(r.priority, r.emoji),
      createdAt: r.create_at
    };
  }
  // app draft/patch -> real columns (always set priority & emoji explicitly)
  function tagToColumns(tag) {
    if (!tag) return { priority: null, emoji: null };
    if (tag.kind === 'pri') return { priority: tag.value, emoji: null };
    if (tag.kind === 'emoji') return { priority: null, emoji: tag.value };
    return { priority: null, emoji: null };
  }
  function toRowInsert(task) {
    return Object.assign(
      { task: task.text, date: task.date, is_complete: !!task.done },
      tagToColumns(task.tag)
    );
  }
  function toRowPatch(p) {
    const out = {};
    if ('text' in p) out.task = p.text;
    if ('done' in p) out.is_complete = p.done;
    if ('date' in p) out.date = p.date;
    if ('tag' in p) Object.assign(out, tagToColumns(p.tag));
    return out;
  }

  // --- Store helpers (Supabase first, localStorage fallback) ---
  async function dbSelectAll() {
    let supaRows = null;
    if (supa) {
      try {
        const { data, error } = await supa.from(TABLE)
          .select('id, task, is_complete, date, create_at, priority, emoji')
          .order('date', { ascending: true })
          .order('create_at', { ascending: true });
        if (!error) supaRows = (data || []).map(fromRow);
      } catch (e) { supaRows = null; }
    }
    const localRows = loadStore();
    if (supaRows) {
      // Merge: Supabase rows win; keep any local-only rows (created during outage)
      const seen = new Set(supaRows.map(r => String(r.id)));
      const merged = supaRows.slice();
      for (const r of localRows) {
        if (!seen.has(String(r.id))) merged.push(r);
      }
      saveStore(merged);   // keep fallback mirror in sync
      return merged.slice().sort(sortByDate);
    }
    return localRows.slice().sort(sortByDate);
  }
  async function dbInsert(task) {
    if (supa) {
      try {
        const { data, error } = await supa.from(TABLE)
          .insert(toRowInsert(task))
          .select('id, task, is_complete, date, create_at, priority, emoji')
          .single();
        if (!error && data) {
          const row = fromRow(data);
          const rows = loadStore(); rows.push(row); saveStore(rows);
          return row;
        }
      } catch (e) { /* fall through to local */ }
    }
    // Fallback: local insert with client-generated id
    const rows = loadStore();
    const row = {
      id: genId(),
      text: task.text,
      date: task.date,
      done: !!task.done,
      tag: task.tag || null,
      createdAt: new Date().toISOString()
    };
    rows.push(row);
    saveStore(rows);
    return row;
  }
  async function dbUpdate(id, patch) {
    if (supa) {
      try {
        const { error } = await supa.from(TABLE).update(toRowPatch(patch)).eq('id', id);
        if (!error) {
          const rows = loadStore();
          const i = rows.findIndex(r => String(r.id) === String(id));
          if (i >= 0) { Object.assign(rows[i], patch); saveStore(rows); }
          return;
        }
      } catch (e) { /* fall through to local */ }
    }
    const rows = loadStore();
    const i = rows.findIndex(r => String(r.id) === String(id));
    if (i >= 0) { Object.assign(rows[i], patch); saveStore(rows); }
  }
  async function dbDelete(id) {
    if (supa) {
      try { await supa.from(TABLE).delete().eq('id', id); }
      catch (e) { /* ignore — still remove locally */ }
    }
    const rows = loadStore().filter(r => String(r.id) !== String(id));
    saveStore(rows);
  }
  function findTaskById(id) {
    return tasks.find(t => String(t.id) === String(id));
  }

  const today = new Date();
  let viewYear = today.getFullYear();
  let viewMonth = today.getMonth();
  let selectedDate = isoDate(today);
  // Selected tag in the picker: { kind: 'pri', value: 'pri-low' } | { kind: 'emoji', value: '📝' } | null
  let selectedTag = null;

  function isoDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  function parseDate(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function formatPretty(s) {
    return parseDate(s).toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
    });
  }
  function escapeHTML(s) {
    return s.replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function renderCalendar() {
    calTitle.textContent = new Date(viewYear, viewMonth, 1).toLocaleDateString('en-US', {
      month: 'long', year: 'numeric'
    });
    const first = new Date(viewYear, viewMonth, 1);
    // Monday-first index (getDay(): 0=Sun..6=Sat)
    let startIdx = first.getDay() - 1;
    if (startIdx < 0) startIdx = 6;
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const todayStr = isoDate(new Date());
    let html = '';
    for (let i = 0; i < startIdx; i++) html += '<span class="cal-blank"></span>';
    for (let d = 1; d <= daysInMonth; d++) {
      const iso = isoDate(new Date(viewYear, viewMonth, d));
      const cls = ['cal-day'];
      if (iso === todayStr) cls.push('today');
      if (iso === selectedDate) cls.push('selected');
      html += `<button type="button" class="${cls.join(' ')}" data-date="${iso}">${d}</button>`;
    }
    calGrid.innerHTML = html;
  }

  function updateDateDisplay() {
    if (!selectedDate) {
      todoDateDisplay.textContent = 'Select a date';
      todoDateDisplay.classList.add('empty');
    } else {
      todoDateDisplay.textContent = formatPretty(selectedDate);
      todoDateDisplay.classList.remove('empty');
    }
  }

  function markerHTML(t) {
    if (!t.tag) return '';
    if (t.tag.kind === 'pri') {
      const label = t.tag.value === 'pri-low' ? 'Low'
        : t.tag.value === 'pri-med' ? 'Med' : 'High';
      return `<span class="todo-marker ${t.tag.value}">${label}</span>`;
    }
    if (t.tag.kind === 'emoji') {
      return `<span class="todo-marker emoji" aria-hidden="true">${escapeHTML(t.tag.value)}</span>`;
    }
    return '';
  }

  function updateCounter() {
    const total = tasks.length;
    const done = tasks.filter(t => t.done).length;
    if (total === 0) {
      todoCount.hidden = true;
      return;
    }
    todoCount.hidden = false;
    todoCountText.innerHTML = `<strong>${done}</strong> of <strong>${total}</strong> task${total === 1 ? '' : 's'} completed`;
    const pct = total ? (done / total) * 100 : 0;
    todoProgressBar.style.width = pct + '%';
  }

  function renderList() {
    if (!tasks.length) {
      todoList.innerHTML = '';
      todoEmpty.style.display = 'block';
      updateCounter();
      return;
    }
    todoEmpty.style.display = 'none';
    const sorted = [...tasks].sort((a, b) => {
      const d = a.date.localeCompare(b.date);
      if (d !== 0) return d;
      const aT = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bT = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return aT - bT;
    });
    todoList.innerHTML = sorted.map(t => `
      <li class="todo-item${t.done ? ' done' : ''}" data-id="${t.id}">
        <label class="todo-check">
          <input type="checkbox" ${t.done ? 'checked' : ''} aria-label="Mark task done" />
          <span class="todo-check-box" aria-hidden="true"></span>
        </label>
        <div class="todo-content">
          <div class="todo-row">
            ${markerHTML(t)}<span class="todo-text" title="Click to edit">${escapeHTML(t.text)}</span>
          </div>
          <div class="todo-date">${formatPretty(t.date)}</div>
        </div>
        <button class="todo-del" type="button" aria-label="Delete task" title="Delete">&times;</button>
      </li>
    `).join('');
    updateCounter();
  }

  function syncTagPicker() {
    if (!todoTags) return;
    todoTags.querySelectorAll('.todo-tag').forEach(btn => {
      const isActive = selectedTag
        && ((selectedTag.kind === 'pri' && btn.dataset.tag === selectedTag.value)
        || (selectedTag.kind === 'emoji' && btn.dataset.tag === 'emoji' && btn.dataset.emoji === selectedTag.value));
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
  }

  function clearTagPicker() {
    selectedTag = null;
    syncTagPicker();
  }

  // Calendar: prev / next month
  calPrev.addEventListener('click', () => {
    viewMonth--;
    if (viewMonth < 0) { viewMonth = 11; viewYear--; }
    renderCalendar();
  });
  calNext.addEventListener('click', () => {
    viewMonth++;
    if (viewMonth > 11) { viewMonth = 0; viewYear++; }
    renderCalendar();
  });

  // Calendar: pick a day (event delegation)
  calGrid.addEventListener('click', e => {
    const btn = e.target.closest('.cal-day');
    if (!btn) return;
    selectedDate = btn.dataset.date;
    renderCalendar();
    updateDateDisplay();
  });

  // Tag picker (single-select, click again to clear)
  if (todoTags) {
    todoTags.addEventListener('click', e => {
      const btn = e.target.closest('.todo-tag');
      if (!btn) return;
      const tag = btn.dataset.tag;        // 'pri-low' | 'pri-med' | 'pri-high' | 'emoji'
      const emoji = btn.dataset.emoji;
      const next = (tag === 'emoji')
        ? { kind: 'emoji', value: emoji }
        : { kind: 'pri', value: tag };
      // Toggle off if clicking the active one
      if (selectedTag && selectedTag.kind === next.kind && selectedTag.value === next.value) {
        selectedTag = null;
      } else {
        selectedTag = next;
      }
      syncTagPicker();
    });
  }

  // Add task — insert into DB, then add the returned row to the list
  todoForm.addEventListener('submit', async e => {
    e.preventDefault();
    const text = todoInput.value.trim();
    if (!text || !selectedDate) return;
    const draft = {
      text,
      date: selectedDate,
      done: false,
      tag: selectedTag ? { ...selectedTag } : null
    };
    todoInput.value = '';
    clearTagPicker();
    try {
      const saved = await dbInsert(draft);
      tasks.push(saved);
      renderList();
    } catch (err) {
      console.error('Insert failed:', err);
      showError('Could not save task. Please try again.');
    }
  });

  // Toggle done — optimistic update + DB write, rollback on failure
  todoList.addEventListener('change', async e => {
    if (!e.target.matches('input[type="checkbox"]')) return;
    const li = e.target.closest('.todo-item');
    const t = findTaskById(li.dataset.id);
    if (!t) return;
    const newDone = e.target.checked;
    const oldDone = t.done;
    t.done = newDone;
    li.classList.toggle('done', t.done);
    updateCounter();
    try {
      await dbUpdate(t.id, { done: newDone });
    } catch (err) {
      console.error('Toggle failed:', err);
      t.done = oldDone;
      e.target.checked = oldDone;
      li.classList.toggle('done', oldDone);
      updateCounter();
      showError('Could not update task. Reverted.');
    }
  });

  // Delete + start inline edit on text click
  todoList.addEventListener('click', async e => {
    const del = e.target.closest('.todo-del');
    if (del) {
      const li = del.closest('.todo-item');
      const t = findTaskById(li.dataset.id);
      if (!t) return;
      const idx = tasks.indexOf(t);
      tasks.splice(idx, 1);
      renderList();
      try {
        await dbDelete(t.id);
      } catch (err) {
        console.error('Delete failed:', err);
        tasks.splice(idx, 0, t);   // restore at original position
        renderList();
        showError('Could not delete task. Restored.');
      }
      return;
    }
    const text = e.target.closest('.todo-text');
    if (text && text.getAttribute('contenteditable') !== 'true') {
      const li = text.closest('.todo-item');
      if (li.classList.contains('done')) return;  // don't edit completed tasks
      text.setAttribute('contenteditable', 'true');
      text.focus();
      const range = document.createRange();
      range.selectNodeContents(text);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  });

  // Inline edit keyboard: Enter saves, Esc cancels
  todoList.addEventListener('keydown', e => {
    if (!e.target.matches('.todo-text[contenteditable="true"]')) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      e.target.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      const li = e.target.closest('.todo-item');
      const t = findTaskById(li.dataset.id);
      if (t) e.target.textContent = t.text;
      e.target.blur();
    }
  });

  // Inline edit save on blur — optimistic update + DB write, rollback on failure
  todoList.addEventListener('focusout', async e => {
    if (!e.target.matches('.todo-text[contenteditable="true"]')) return;
    const text = e.target;
    const li = text.closest('.todo-item');
    const t = findTaskById(li.dataset.id);
    text.removeAttribute('contenteditable');
    if (!t) return;
    const newText = text.textContent.trim();
    if (!newText) {
      text.textContent = t.text;  // revert empty
      return;
    }
    if (newText === t.text) return;  // no change
    const oldText = t.text;
    t.text = newText;
    try {
      await dbUpdate(t.id, { text: newText });
    } catch (err) {
      console.error('Edit save failed:', err);
      t.text = oldText;
      text.textContent = oldText;
      showError('Could not save edit. Reverted.');
    }
  });

  // Init — render UI immediately, then load tasks from DB
  renderCalendar();
  updateDateDisplay();
  syncTagPicker();
  todoEmpty.textContent = 'Loading tasks…';
  todoEmpty.classList.add('todo-loading');
  todoEmpty.style.display = 'block';
  dbSelectAll()
    .then(loaded => {
      tasks = loaded;
      todoEmpty.classList.remove('todo-loading');
      todoEmpty.textContent = 'No tasks yet. Pick a date and add your first one.';
      renderList();
    })
    .catch(err => {
      console.error('Load failed:', err);
      todoEmpty.classList.remove('todo-loading');
      todoEmpty.textContent = 'Could not load tasks.';
      todoEmpty.style.display = 'block';
      updateCounter();
    });
})();
