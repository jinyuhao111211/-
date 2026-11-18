/* ===================================================================
 * 作业批改台 — 前端逻辑
 * =================================================================== */
(function () {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const LS = { roster: 'hw.roster.v2', records: 'hw.records.v2', settings: 'hw.settings.v2' };

  /* ---------------------- 状态 ---------------------- */
  const defaultSettings = { model: 'agnes-2.5-flash', subject: '数学', fullScore: 100, extraPrompt: '', apiKey: '', apiBase: '' };
  let currentUser = '';
  let isAdmin = false;
  const lsKey = (k) => (currentUser ? k + '::' + currentUser : k);

  function emptyRoster() {
    return { classes: [{ id: uid(), name: '我的班级', students: [] }], activeId: null };
  }

  const state = {
    roster: emptyRoster(),
    records: [],
    settings: Object.assign({}, defaultSettings),
    queue: [],
    busy: false,
  };

  function load(k, d) {
    try {
      const v = localStorage.getItem(lsKey(k));
      return v ? JSON.parse(v) : d;
    } catch (e) {
      return d;
    }
  }
  function save(k, v) {
    try {
      localStorage.setItem(lsKey(k), JSON.stringify(v));
    } catch (e) {
      if (k === LS.records) {
        state.records = state.records.slice(0, 60);
        try { localStorage.setItem(lsKey(k), JSON.stringify(state.records)); } catch (e2) {}
        toast('本地存储空间不足，已自动清理较早的记录');
      }
    }
  }

  /** 登录后加载该账号的数据 */
  function loadUserData() {
    const r = load(LS.roster, null);
    state.roster = r && Array.isArray(r.classes) && r.classes.length ? r : emptyRoster();
    if (!state.roster.activeId || !state.roster.classes.some((c) => c.id === state.roster.activeId)) {
      state.roster.activeId = state.roster.classes[0].id;
    }
    state.records = load(LS.records, []) || [];
    state.settings = Object.assign({}, defaultSettings, load(LS.settings, {}) || {});
    state.queue = [];
    state.busy = false;
  }

  const saveRoster = () => save(LS.roster, state.roster);
  const saveRecords = () => save(LS.records, state.records);
  const saveSettings = () => save(LS.settings, state.settings);

  const activeClass = () => state.roster.classes.find((c) => c.id === state.roster.activeId) || state.roster.classes[0];
  const students = () => (activeClass() ? activeClass().students : []);

  /* ---------------------- 提示 ---------------------- */
  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 2600);
  }

  /* ---------------------- 导航 ---------------------- */
  function go(view, silent) {
    if (!document.getElementById('view-' + view)) view = 'grade';
    $$('.view').forEach((v) => v.classList.toggle('hidden', v.id !== 'view-' + view));
    $$('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    window.scrollTo({ top: 0, behavior: 'auto' });
    if (!silent) {
      try {
        history.replaceState(null, '', '#' + view);
      } catch (e) {}
    }
    if (view === 'report') renderReport();
    if (view === 'roster') renderRoster();
  }
  $$('[data-view]').forEach((b) => b.addEventListener('click', () => go(b.dataset.view)));
  $('#btn-goto-report').addEventListener('click', () => go('report'));
  $('#btn-goto-roster').addEventListener('click', () => go('roster'));

  /* ===================================================================
   * 图片处理
   * =================================================================== */
  function readFile(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error('读取图片失败'));
      r.readAsDataURL(file);
    });
  }

  function shrink(dataUrl, maxSide, quality) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const cv = document.createElement('canvas');
        cv.width = w;
        cv.height = h;
        const ctx = cv.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        try {
          resolve(cv.toDataURL('image/jpeg', quality));
        } catch (e) {
          resolve(dataUrl);
        }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  async function fileToItem(file) {
    let dataUrl = await readFile(file);
    const big = await shrink(dataUrl, 1600, 0.86);
    const thumb = await shrink(dataUrl, 240, 0.62);
    return { id: uid(), name: file.name || '作业图片', dataUrl: big, thumb, studentId: '', status: 'idle', error: '' };
  }

  function nextFreeStudent() {
    const list = students();
    if (!list.length) return '';
    const used = new Set(state.queue.map((q) => q.studentId).filter(Boolean));
    const free = list.find((s) => !used.has(s.id));
    return free ? free.id : '';
  }

  async function addFiles(files) {
    const imgs = Array.from(files).filter((f) => f && f.type && f.type.startsWith('image/'));
    if (!imgs.length) return toast('请选择图片文件');
    toast(`正在处理 ${imgs.length} 张图片…`);
    for (const f of imgs) {
      try {
        const item = await fileToItem(f);
        item.studentId = nextFreeStudent();
        state.queue.push(item);
      } catch (e) {
        toast('有图片读取失败，已跳过');
      }
    }
    renderQueue();
  }

  function addDataUrl(dataUrl) {
    shrink(dataUrl, 240, 0.62).then((thumb) => {
      state.queue.push({
        id: uid(),
        name: '相机拍摄 ' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
        dataUrl,
        thumb,
        studentId: nextFreeStudent(),
        status: 'idle',
        error: '',
      });
      renderQueue();
    });
  }

  /* ===================================================================
   * 队列
   * =================================================================== */
  function renderQueue() {
    const box = $('#queue');
    const q = state.queue;
    $('#queue-count').textContent = q.length;
    $('#queue-empty').classList.toggle('hidden', q.length > 0);
    box.innerHTML = q
      .map(
        (it) => `
      <div class="q-item" data-id="${it.id}">
        <img class="q-thumb" src="${it.thumb}" alt="" />
        <div class="q-info">
          <div class="q-name">${esc(it.name)}</div>
          <select data-act="student">
            <option value="">未指定学生</option>
            ${students()
              .map((s) => `<option value="${s.id}" ${s.id === it.studentId ? 'selected' : ''}>${esc(s.no ? s.no + ' ' : '')}${esc(s.name)}</option>`)
              .join('')}
          </select>
        </div>
        <div class="q-status ${it.status}">${statusText(it)}</div>
        <button class="q-del" data-act="del" aria-label="移除">
          <svg viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>
        </button>
      </div>`
      )
      .join('');

    const pending = q.filter((i) => i.status === 'idle' || i.status === 'error').length;
    const done = q.filter((i) => i.status === 'done').length;
    const grading = q.filter((i) => i.status === 'grading').length;
    $('#queue-hint').textContent = grading
      ? `正在批改 ${grading} 份…`
      : pending
      ? `${pending} 份待批改`
      : done
      ? `${done} 份已完成`
      : '已就绪';
    const btn = $('#btn-grade');
    btn.disabled = state.busy || pending === 0 || !hasKey();
    btn.classList.toggle('busy', state.busy);
    btn.textContent = state.busy ? '批改中' : !hasKey() ? '请先配置密钥' : pending > 1 ? `开始批改（${pending} 份）` : '开始批改';
  }

  function statusText(it) {
    if (it.status === 'grading') return '批改中…';
    if (it.status === 'done') return `✓ ${it.result ? it.result.score : ''} 分`;
    if (it.status === 'error') return '失败';
    return '待批改';
  }

  $('#queue').addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-act="student"]');
    if (!sel) return;
    const id = e.target.closest('.q-item').dataset.id;
    const it = state.queue.find((x) => x.id === id);
    if (it) it.studentId = sel.value;
  });
  $('#queue').addEventListener('click', (e) => {
    if (!e.target.closest('[data-act="del"]')) return;
    const id = e.target.closest('.q-item').dataset.id;
    state.queue = state.queue.filter((x) => x.id !== id);
    renderQueue();
  });
  $('#btn-clear-queue').addEventListener('click', () => {
    if (!state.queue.length) return;
    state.queue = [];
    renderQueue();
  });

  /* ===================================================================
   * 上传入口
   * =================================================================== */
  $('#btn-pick').addEventListener('click', () => $('#file-pick').click());
  $('#file-pick').addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length) addFiles(e.target.files);
    e.target.value = '';
  });
  $('#file-cam').addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length) addFiles(e.target.files);
    e.target.value = '';
  });

  const dz = $('#dropzone');
  dz.addEventListener('click', () => $('#file-pick').click());
  ['dragenter', 'dragover'].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.add('hover');
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.remove('hover');
    })
  );
  dz.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });
  document.addEventListener('paste', (e) => {
    const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
    const files = items.filter((i) => i.type.startsWith('image/')).map((i) => i.getAsFile()).filter(Boolean);
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  });

  /* ===================================================================
   * 摄像头
   * =================================================================== */
  let camStream = null;
  let camFacing = 'environment';
  let camCount = 0;

  async function startCam() {
    stopCam();
    const video = $('#cam-video');
    const fallback = $('#cam-fallback');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      fallback.hidden = false;
      return;
    }
    try {
      camStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: camFacing }, width: { ideal: 1920 }, height: { ideal: 1440 } },
        audio: false,
      });
      video.srcObject = camStream;
      video.style.display = 'block';
      fallback.hidden = true;
      await video.play().catch(() => {});
    } catch (err) {
      fallback.hidden = false;
      video.style.display = 'none';
    }
  }
  function stopCam() {
    if (camStream) {
      camStream.getTracks().forEach((t) => t.stop());
      camStream = null;
    }
  }
  function openCam() {
    camCount = 0;
    $('#cam-count').textContent = '0 张';
    $('#cam-modal').hidden = false;
    startCam();
  }
  function closeCam() {
    stopCam();
    $('#cam-modal').hidden = true;
    if (camCount) toast(`已加入 ${camCount} 张照片`);
  }

  $('#btn-shoot').addEventListener('click', openCam);
  $('#cam-close').addEventListener('click', closeCam);
  $('#cam-done').addEventListener('click', closeCam);
  $('#cam-modal').addEventListener('click', (e) => {
    if (e.target.id === 'cam-modal') closeCam();
  });
  $('#cam-switch').addEventListener('click', () => {
    camFacing = camFacing === 'environment' ? 'user' : 'environment';
    startCam();
  });
  $('#cam-native').addEventListener('click', () => {
    closeCam();
    $('#file-cam').click();
  });
  $('#cam-shot').addEventListener('click', () => {
    const video = $('#cam-video');
    if (!camStream || !video.videoWidth) {
      $('#file-cam').click();
      return;
    }
    const cv = document.createElement('canvas');
    cv.width = video.videoWidth;
    cv.height = video.videoHeight;
    cv.getContext('2d').drawImage(video, 0, 0, cv.width, cv.height);
    const url = cv.toDataURL('image/jpeg', 0.92);
    shrink(url, 1600, 0.86).then((big) => addDataUrl(big));
    camCount++;
    $('#cam-count').textContent = camCount + ' 张';
    if (navigator.vibrate) navigator.vibrate(18);
  });

  /* ===================================================================
   * 批改
   * =================================================================== */
  async function gradeOne(item) {
    item.status = 'grading';
    renderQueue();
    const st = students().find((s) => s.id === item.studentId);
    const cls = activeClass();
    try {
      const res = await fetch('/api/grade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: item.dataUrl,
          subject: state.settings.subject,
          fullScore: Number(state.settings.fullScore) || 100,
          extraPrompt: state.settings.extraPrompt,
          model: state.settings.model,
          studentName: st ? st.name : '',
          apiKey: localKey(),
          apiBase: localBase(),
        }),
      });
      if (res.status === 401) {
        showAuth('login');
        throw new Error('登录已失效，请重新登录');
      }
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || '批改失败');
      item.result = j.data;
      item.status = 'done';

      const rec = {
        id: uid(),
        createdAt: Date.now(),
        className: cls ? cls.name : '',
        studentId: st ? st.id : '',
        studentName: st ? st.name : '未指定',
        studentNo: st ? st.no : '',
        subject: j.data.subject || state.settings.subject,
        fullScore: j.data.fullScore || Number(state.settings.fullScore) || 100,
        thumb: item.thumb,
        result: j.data,
      };
      state.records.unshift(rec);
      if (state.records.length > 300) state.records.length = 300;
      saveRecords();
      renderResults();
      renderHero();
    } catch (err) {
      item.status = 'error';
      item.error = err.message || '批改失败';
    }
    renderQueue();
  }

  async function runGrading() {
    if (state.busy) return;
    if (!hasKey()) {
      toast('请先在「设置」里填写 API 密钥');
      go('settings');
      return;
    }
    const pending = state.queue.filter((i) => i.status === 'idle' || i.status === 'error');
    if (!pending.length) return toast('没有待批改的作业');
    state.busy = true;
    renderQueue();

    let idx = 0;
    const CONCURRENCY = 2;
    const worker = async () => {
      while (idx < pending.length) {
        const item = pending[idx++];
        await gradeOne(item);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));

    state.busy = false;
    renderQueue();
    const failed = state.queue.filter((i) => i.status === 'error').length;
    const ok = state.queue.filter((i) => i.status === 'done').length;
    toast(failed ? `完成 ${ok} 份，${failed} 份失败` : `已完成 ${ok} 份批改`);
    if (ok) {
      const el = $('#results-card');
      if (el) setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }), 260);
    }
  }
  $('#btn-grade').addEventListener('click', runGrading);

  /* ===================================================================
   * 结果展示
   * =================================================================== */
  function scoreColor(pct) {
    if (pct >= 85) return '#0f9d58';
    if (pct >= 60) return '#d97706';
    return '#dc2626';
  }
  function scoreBadge(pct) {
    if (pct >= 85) return '<span class="badge ok">优秀</span>';
    if (pct >= 60) return '<span class="badge mid">合格</span>';
    return '<span class="badge bad">待加强</span>';
  }

  function ringSVG(pct) {
    const r = 23;
    const c = 2 * Math.PI * r;
    const off = c * (1 - pct / 100);
    const col = scoreColor(pct);
    return `<svg viewBox="0 0 54 54" width="54" height="54">
      <circle cx="27" cy="27" r="${r}" fill="none" stroke="#eef0f6" stroke-width="6"/>
      <circle cx="27" cy="27" r="${r}" fill="none" stroke="${col}" stroke-width="6" stroke-linecap="round"
        stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"/>
    </svg>`;
  }

  function renderResults() {
    const box = $('#results');
    const list = state.records.slice(0, 20);
    $('#res-count').textContent = state.records.length;
    $('#results-empty').classList.toggle('hidden', list.length > 0);
    if (!list.length) {
      box.innerHTML = '';
      return;
    }
    box.innerHTML = list
      .map((rec, i) => {
        const r = rec.result;
        const pct = Math.round((r.score / (rec.fullScore || 100)) * 100);
        const qs = r.questions || [];
        return `<div class="rc ${i === 0 ? 'open' : ''}" data-id="${rec.id}">
          <div class="rc-head" data-act="toggle">
            <div class="ring">${ringSVG(pct)}<b style="color:${scoreColor(pct)}">${r.score}</b></div>
            <div class="rc-meta">
              <h3>${esc(rec.studentName)} · ${esc(r.title || '作业')} ${scoreBadge(pct)}</h3>
              <p>${esc(rec.subject || '')} · 满分 ${rec.fullScore} · ${r.correctCount}/${r.totalQuestions} 题正确 · 正确率 ${r.accuracy}% · ${fmtTime(rec.createdAt)}</p>
            </div>
            <span class="chev">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </span>
          </div>
          <div class="rc-body">
            ${r.summary ? `<p class="rc-summary">${esc(r.summary)}</p>` : ''}
            <div class="q-list">
              ${qs
                .map(
                  (q) => `<div class="qrow">
                <div class="qno">${esc(q.no)}</div>
                <div class="qbody">
                  <div>${q.isCorrect === true ? '<span class="badge ok">正确</span>' : q.isCorrect === false ? '<span class="badge bad">错误</span>' : '<span class="badge mid">待确认</span>'}
                    ${q.type ? `<span class="tag">${esc(q.type)}</span>` : ''}
                    ${q.knowledgePoint ? `<span class="tag kp">${esc(q.knowledgePoint)}</span>` : ''}
                  </div>
                  <div class="qans">
                    ${q.studentAnswer ? `<span>作答：${q.isCorrect === false ? `<s>${esc(q.studentAnswer)}</s>` : esc(q.studentAnswer)}</span>` : ''}
                    ${q.correctAnswer ? `<span>正确：<em>${esc(q.correctAnswer)}</em></span>` : ''}
                  </div>
                  ${q.comment ? `<div class="qans"><span>${esc(q.comment)}</span></div>` : ''}
                </div>
              </div>`
                )
                .join('')}
            </div>
            <div class="rc-foot">
              ${r.strengths && r.strengths.length ? `<div class="foot-block"><b>亮点</b><ul>${r.strengths.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
              ${r.weaknesses && r.weaknesses.length ? `<div class="foot-block"><b>薄弱</b><ul>${r.weaknesses.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
              ${r.suggestions && r.suggestions.length ? `<div class="foot-block"><b>建议</b><ul>${r.suggestions.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
            </div>
            <div class="rc-actions">
              <button class="btn ghost" data-act="del" data-id="${rec.id}">删除这条记录</button>
            </div>
          </div>
        </div>`;
      })
      .join('');
  }

  $('#results').addEventListener('click', (e) => {
    const del = e.target.closest('[data-act="del"]');
    if (del) {
      state.records = state.records.filter((r) => r.id !== del.dataset.id);
      saveRecords();
      renderResults();
      renderHero();
      toast('已删除');
      return;
    }
    if (e.target.closest('[data-act="toggle"]')) {
      e.target.closest('.rc').classList.toggle('open');
    }
  });

  function fmtTime(ts) {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function renderHero() {
    const recs = state.records;
    $('#hero-total').textContent = recs.length;
    $('#hero-students').textContent = students().length;
    if (!recs.length) {
      $('#hero-avg').textContent = '—';
      return;
    }
    const avg = recs.reduce((a, r) => a + (r.result.score / (r.fullScore || 100)) * 100, 0) / recs.length;
    $('#hero-avg').textContent = Math.round(avg);
  }

  /* ===================================================================
   * 名单
   * =================================================================== */
  function renderClassSelects() {
    const opts = state.roster.classes
      .map((c) => `<option value="${c.id}" ${c.id === state.roster.activeId ? 'selected' : ''}>${esc(c.name)}（${c.students.length}人）</option>`)
      .join('');
    $('#in-class').innerHTML = opts;
    $('#roster-class-select').innerHTML = opts;
  }

  function renderRoster() {
    const cls = activeClass();
    renderClassSelects();
    $('#roster-class-name').value = cls ? cls.name : '';
    const list = students();
    $('#roster-count').textContent = list.length;
    $('#roster-sub').textContent = cls ? cls.name : '';
    $('#roster-empty').classList.toggle('hidden', list.length > 0);
    $('#roster-list').innerHTML = list
      .map(
        (s, i) => `<div class="r-item" data-id="${s.id}">
          <span class="r-no">${esc(s.no || i + 1)}</span>
          <span class="r-name">${esc(s.name)}</span>
          <button class="icon-btn" data-act="del" aria-label="删除">
            <svg viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>
          </button>
        </div>`
      )
      .join('');

    const mini = $('#roster-mini');
    mini.innerHTML = list
      .slice(0, 10)
      .map((s) => `<span class="chip">${esc(s.name)}</span>`)
      .join('') + (list.length > 10 ? `<span class="chip more">+${list.length - 10}</span>` : '');
    $('#class-hint').textContent = list.length
      ? `共 ${list.length} 人，上传作业时会按顺序自动分配学生`
      : '未导入学生名单，批改结果将按「未指定」归档。';
    renderHero();
    renderQueue();
  }

  $('#roster-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act="del"]');
    if (!btn) return;
    const id = e.target.closest('.r-item').dataset.id;
    const cls = activeClass();
    cls.students = cls.students.filter((s) => s.id !== id);
    saveRoster();
    renderRoster();
  });

  function parseNames(text) {
    return text
      .split(/[\n\r]+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(/[,，\t;；\s]+/).filter(Boolean);
        if (parts.length === 1) return { no: '', name: parts[0] };
        const maybeNo = parts[0];
        if (/^\d{1,4}$/.test(maybeNo) && parts[1]) return { no: maybeNo, name: parts.slice(1).join(' ') };
        return { no: '', name: line.replace(/[,，\t;；]+/g, ' ') };
      });
  }

  function addStudents(text) {
    const cls = activeClass();
    const parsed = parseNames(text);
    if (!parsed.length) return toast('没有解析到学生姓名');
    const exist = new Set(cls.students.map((s) => s.name));
    let added = 0;
    parsed.forEach((p) => {
      if (exist.has(p.name)) return;
      exist.add(p.name);
      cls.students.push({ id: uid(), no: p.no || String(cls.students.length + 1).padStart(2, '0'), name: p.name });
      added++;
    });
    saveRoster();
    renderRoster();
    toast(added ? `已添加 ${added} 名学生` : '这些学生已在名单中');
  }

  $('#btn-roster-add').addEventListener('click', () => {
    const ta = $('#roster-bulk');
    addStudents(ta.value);
    ta.value = '';
  });
  $('#roster-file').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const text = await f.text();
    addStudents(text);
    e.target.value = '';
  });
  $('#btn-roster-clear').addEventListener('click', () => {
    if (!confirm('确定清空当前班级的名单吗？')) return;
    activeClass().students = [];
    saveRoster();
    renderRoster();
  });
  $('#roster-class-name').addEventListener('change', (e) => {
    const cls = activeClass();
    cls.name = e.target.value.trim() || '未命名班级';
    saveRoster();
    renderRoster();
  });
  $('#roster-class-select').addEventListener('change', (e) => {
    state.roster.activeId = e.target.value;
    saveRoster();
    renderRoster();
    renderResults();
  });
  $('#in-class').addEventListener('change', (e) => {
    state.roster.activeId = e.target.value;
    saveRoster();
    renderRoster();
  });
  $('#btn-class-new').addEventListener('click', () => {
    const name = prompt('新班级名称', '班级 ' + (state.roster.classes.length + 1));
    if (!name) return;
    const c = { id: uid(), name: name.trim(), students: [] };
    state.roster.classes.push(c);
    state.roster.activeId = c.id;
    saveRoster();
    renderRoster();
    toast('已创建班级：' + c.name);
  });

  /* ===================================================================
   * 图表
   * =================================================================== */
  function columnChart(data, opts) {
    const o = Object.assign({ height: 170, barMax: 40 }, opts || {});
    const W = 340, H = o.height, padX = 12, padT = 24, padB = 26;
    const max = Math.max(1, ...data.map((d) => d.value));
    const n = Math.max(1, data.length);
    const slot = (W - padX * 2) / n;
    const bw = Math.min(o.barMax, slot * 0.58);
    const chartH = H - padT - padB;
    let g = '';
    for (let i = 0; i <= 3; i++) {
      const y = padT + (chartH * i) / 3;
      g += `<line x1="${padX}" y1="${y}" x2="${W - padX}" y2="${y}" stroke="#eef0f6" stroke-width="1"/>`;
    }
    let bars = '';
    data.forEach((d, i) => {
      const h = Math.round((d.value / max) * chartH);
      const x = padX + slot * i + (slot - bw) / 2;
      const y = padT + chartH - h;
      const col = d.color || '#4f46e5';
      bars += `<rect x="${x.toFixed(1)}" y="${y}" width="${bw.toFixed(1)}" height="${Math.max(h, 2)}" rx="6" fill="${col}" opacity="${h ? 1 : 0.25}"/>`;
      if (d.value > 0) bars += `<text x="${(x + bw / 2).toFixed(1)}" y="${(y - 7).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="700" fill="#3f4450">${d.value}</text>`;
      bars += `<text x="${(x + bw / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="10.5" fill="#7b8291">${esc(d.label)}</text>`;
    });
    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block" role="img">${g}${bars}</svg>`;
  }

  function donutChart(pct) {
    const r = 52, c = 2 * Math.PI * r, off = c * (1 - pct / 100);
    const col = scoreColor(pct);
    return `<svg viewBox="0 0 140 140" width="150" height="150" role="img">
      <circle cx="70" cy="70" r="${r}" fill="none" stroke="#eef0f6" stroke-width="16"/>
      <circle cx="70" cy="70" r="${r}" fill="none" stroke="${col}" stroke-width="16" stroke-linecap="round"
        stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 70 70)"/>
      <text x="70" y="66" text-anchor="middle" font-size="26" font-weight="800" fill="#14161c">${pct}%</text>
      <text x="70" y="88" text-anchor="middle" font-size="11" fill="#7b8291">平均正确率</text>
    </svg>`;
  }

  function hbars(items, colorFn, fixedMax) {
    if (!items.length) return '<p class="muted small">暂无数据</p>';
    const max = fixedMax || Math.max(1, ...items.map((i) => i.value));
    return items
      .map((i) => {
        const w = Math.max(3, Math.round((i.value / max) * 100));
        const col = colorFn ? colorFn(i.value) : '#4f46e5';
        return `<div class="hb">
          <div class="hb-top"><span>${esc(i.label)}</span><b>${esc(i.text != null ? i.text : i.value)}</b></div>
          <div class="hb-track"><div class="hb-fill" style="width:${w}%;background:${col}"></div></div>
        </div>`;
      })
      .join('');
  }

  /* ===================================================================
   * 报告
   * =================================================================== */
  function filteredRecords() {
    const range = $('#report-range').value;
    const stu = $('#report-student').value;
    const clsName = activeClass() ? activeClass().name : '';
    const now = Date.now();
    const span = range === 'today' ? 24 * 3600e3 : range === '7' ? 7 * 86400e3 : range === '30' ? 30 * 86400e3 : Infinity;
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    return state.records.filter((r) => {
      if (r.className && clsName && r.className !== clsName) return false;
      if (stu && r.studentName !== stu) return false;
      if (range === 'today') return r.createdAt >= todayStart.getTime();
      return now - r.createdAt <= span;
    });
  }

  function syncStudentFilter() {
    const sel = $('#report-student');
    const cur = sel.value;
    const clsName = activeClass() ? activeClass().name : '';
    const names = Array.from(
      new Set(
        state.records
          .filter((r) => !r.className || !clsName || r.className === clsName)
          .map((r) => r.studentName || '未指定')
      )
    ).sort((a, b) => a.localeCompare(b, 'zh-CN'));
    sel.innerHTML =
      '<option value="">全部学生</option>' +
      names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
    if (cur && names.includes(cur)) sel.value = cur;
  }

  function renderReport() {
    syncStudentFilter();
    const recs = filteredRecords();
    const stuFilter = $('#report-student').value;
    $('#report-empty').classList.toggle('hidden', recs.length > 0);
    $('#report-body').classList.toggle('hidden', recs.length === 0);
    if (!recs.length) {
      $('#report-empty').textContent = state.records.length
        ? '当前筛选条件下没有记录，换个学生或时间范围试试。'
        : '还没有批改记录。先去「批改」页上传几份作业吧。';
      return;
    }
    const stamp = new Date().toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
    const cls = activeClass();
    $('#report-sub').textContent = `${cls ? cls.name : '全部'}${stuFilter ? ' · ' + stuFilter : ''} · ${recs.length} 份作业 · 更新于 ${stamp}`;

    const pcts = recs.map((r) => (r.result.score / (r.fullScore || 100)) * 100);
    const avg = pcts.reduce((a, b) => a + b, 0) / pcts.length;
    const pass = pcts.filter((p) => p >= 60).length;
    const exc = pcts.filter((p) => p >= 85).length;
    const accSum = recs.reduce((a, r) => a + (r.result.accuracy || 0), 0);

    $('#k-count').textContent = recs.length;
    $('#k-avg').textContent = avg.toFixed(1);
    $('#k-acc').textContent = (accSum / recs.length).toFixed(1) + '%';
    $('#k-pass').textContent = Math.round((pass / recs.length) * 100) + '%';
    $('#k-exc').textContent = Math.round((exc / recs.length) * 100) + '%';

    // 分数分布
    const buckets = [
      { label: '0-59', min: 0, max: 59.9, color: '#dc2626' },
      { label: '60-69', min: 60, max: 69.9, color: '#f97316' },
      { label: '70-79', min: 70, max: 79.9, color: '#d97706' },
      { label: '80-89', min: 80, max: 89.9, color: '#4f46e5' },
      { label: '90-100', min: 90, max: 100.1, color: '#0f9d58' },
    ].map((b) => ({ label: b.label, value: pcts.filter((p) => p >= b.min && p < b.max).length, color: b.color }));
    $('#chart-dist').innerHTML = columnChart(buckets);
    $('#dist-sub').textContent = `按百分制折算 · 共 ${recs.length} 份`;

    // 正确率环
    const acc = accSum / recs.length;
    $('#chart-donut').innerHTML = donutChart(Math.round(acc));
    const totalQ = recs.reduce((a, r) => a + (r.result.totalQuestions || 0), 0);
    const rightQ = recs.reduce((a, r) => a + (r.result.correctCount || 0), 0);
    $('#donut-legend').innerHTML = `
      <div class="lg"><i style="background:#0f9d58"></i>答对 ${rightQ} 题</div>
      <div class="lg"><i style="background:#eef0f6"></i>答错 ${totalQ - rightQ} 题</div>
      <div class="lg"><i style="background:#4f46e5"></i>共 ${totalQ} 题 · ${recs.length} 份</div>
      <div class="lg muted small">平均每份 ${(totalQ / recs.length).toFixed(1)} 题</div>`;

    // 知识点掌握度
    const kp = new Map();
    recs.forEach((r) =>
      (r.result.questions || []).forEach((q) => {
        const key = (q.knowledgePoint || '').trim();
        if (!key) return;
        const o = kp.get(key) || { total: 0, wrong: 0 };
        o.total++;
        if (q.isCorrect === false) o.wrong++;
        kp.set(key, o);
      })
    );
    const kpItems = Array.from(kp.entries())
      .map(([k, v]) => ({ label: k, value: Math.round(((v.total - v.wrong) / v.total) * 100), text: `${Math.round(((v.total - v.wrong) / v.total) * 100)}%`, total: v.total }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 8);
    $('#chart-knowledge').innerHTML = kpItems.length
      ? hbars(kpItems, (v) => (v >= 85 ? '#0f9d58' : v >= 60 ? '#d97706' : '#dc2626'), 100)
      : '<p class="muted small">AI 未返回知识点信息，可尝试使用更聪明的模型（agnes-2.5-pro）。</p>';

    // 学生排行 / 单人趋势
    if (stuFilter) {
      $('#rank-title').textContent = '该生得分趋势';
      const sorted = recs.slice().sort((a, b) => a.createdAt - b.createdAt).slice(-12);
      if (sorted.length > 1) {
        $('#chart-ranking').innerHTML = columnChart(
          sorted.map((r) => {
            const d = new Date(r.createdAt);
            return {
              label: `${d.getMonth() + 1}/${d.getDate()}`,
              value: Math.round((r.result.score / (r.fullScore || 100)) * 100),
              color: (r.result.score / (r.fullScore || 100)) >= 0.85 ? '#0f9d58' : (r.result.score / (r.fullScore || 100)) >= 0.6 ? '#4f46e5' : '#dc2626',
            };
          }),
          { height: 180 }
        );
      } else {
        const r0 = sorted[0];
        $('#chart-ranking').innerHTML = hbars(
          [
            { label: '正确率', value: r0.result.accuracy, text: r0.result.accuracy + '%' },
            { label: '得分率', value: Math.round((r0.result.score / (r0.fullScore || 100)) * 100), text: Math.round((r0.result.score / (r0.fullScore || 100)) * 100) + '%' },
          ],
          (v) => (v >= 85 ? '#0f9d58' : v >= 60 ? '#4f46e5' : '#dc2626'),
          100
        );
      }
    } else {
      $('#rank-title').textContent = '学生正确率排行';
      const byStudent = new Map();
      recs.forEach((r) => {
        const k = r.studentName || '未指定';
        const o = byStudent.get(k) || { n: 0, acc: 0 };
        o.n++;
        o.acc += r.result.accuracy || 0;
        byStudent.set(k, o);
      });
      const rankItems = Array.from(byStudent.entries())
        .map(([k, v]) => ({ label: `${k}（${v.n}份）`, value: Math.round(v.acc / v.n), text: Math.round(v.acc / v.n) + '%' }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 10);
      $('#chart-ranking').innerHTML = hbars(rankItems, (v) => (v >= 85 ? '#0f9d58' : v >= 60 ? '#4f46e5' : '#dc2626'), 100);
    }

    // 高频错题
    const wrongMap = new Map();
    recs.forEach((r) =>
      (r.result.questions || []).forEach((q) => {
        if (q.isCorrect !== false) return;
        const key = q.knowledgePoint ? q.knowledgePoint : `第 ${q.no} 题`;
        const o = wrongMap.get(key) || { count: 0, samples: [], answers: new Set() };
        o.count++;
        if (o.samples.length < 3) o.samples.push(`${r.studentName}：${q.studentAnswer || '空'}${q.correctAnswer ? ' → ' + q.correctAnswer : ''}`);
        wrongMap.set(key, o);
      })
    );
    const wrongItems = Array.from(wrongMap.entries()).sort((a, b) => b[1].count - a[1].count).slice(0, 6);
    $('#wrong-list').innerHTML = wrongItems.length
      ? wrongItems
          .map(
            ([k, v]) => `<div class="wrong-item">
              <div class="w-top"><b>${esc(k)}</b><span class="muted small">${v.count} 人次出错</span></div>
              <div class="w-body">${v.samples.map((s) => esc(s)).join('　·　')}</div>
            </div>`
          )
          .join('')
      : '<p class="muted small">没有错题，全班表现优秀 🎉</p>';

    // 明细
    $('#detail-sub').textContent = `${recs.length} 条`;
    $('#detail-table tbody').innerHTML = recs
      .slice(0, 60)
      .map(
        (r) => `<tr>
          <td>${esc(r.studentName)}</td>
          <td>${esc(r.result.title || '作业')}</td>
          <td class="num">${r.result.score} / ${r.fullScore}</td>
          <td class="num">${r.result.accuracy}%</td>
          <td class="num">${r.result.correctCount}/${r.result.totalQuestions}</td>
          <td>${fmtTime(r.createdAt)}</td>
        </tr>`
      )
      .join('');
  }

  $('#report-range').addEventListener('change', renderReport);
  $('#report-student').addEventListener('change', renderReport);
  $('#btn-print').addEventListener('click', () => window.print());
  $('#btn-export-csv').addEventListener('click', () => {
    const recs = filteredRecords();
    if (!recs.length) return toast('没有可导出的记录');
    const rows = [['学生', '作业', '科目', '得分', '满分', '正确率', '题数', '答对', '时间']];
    recs.forEach((r) =>
      rows.push([
        r.studentName,
        r.result.title || '作业',
        r.subject || '',
        r.result.score,
        r.fullScore,
        r.result.accuracy + '%',
        r.result.totalQuestions,
        r.result.correctCount,
        new Date(r.createdAt).toLocaleString('zh-CN', { hour12: false }),
      ])
    );
    const csv = '\uFEFF' + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    download('成绩单_' + new Date().toISOString().slice(0, 10) + '.csv', csv, 'text/csv;charset=utf-8');
  });

  function download(name, content, mime) {
    const blob = new Blob([content], { type: mime || 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 400);
  }

  /* ===================================================================
   * 设置
   * =================================================================== */
  function renderSettings() {
    $('#set-model').value = state.settings.model;
    $('#set-extra').value = state.settings.extraPrompt || '';
    $('#in-subject').value = state.settings.subject;
    $('#in-full').value = state.settings.fullScore;
    $('#in-base').value = localBase();
  }

  $('#btn-save-settings').addEventListener('click', () => {
    state.settings.model = $('#set-model').value;
    state.settings.extraPrompt = $('#set-extra').value.trim();
    saveSettings();
    toast('偏好已保存');
  });
  $('#in-subject').addEventListener('change', (e) => {
    state.settings.subject = e.target.value;
    saveSettings();
  });
  $('#in-full').addEventListener('change', (e) => {
    const v = Math.max(1, Math.min(300, Number(e.target.value) || 100));
    e.target.value = v;
    state.settings.fullScore = v;
    saveSettings();
  });
  $('#set-model').addEventListener('change', () => {
    state.settings.model = $('#set-model').value;
    saveSettings();
  });

  $('#btn-export-json').addEventListener('click', () => {
    const safeSettings = Object.assign({}, state.settings);
    delete safeSettings.apiKey; // 导出的数据里不包含密钥
    download('作业批改数据_' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify({ roster: state.roster, records: state.records, settings: safeSettings }, null, 2), 'application/json');
  });
  $('#btn-clear-records').addEventListener('click', () => {
    if (!confirm('确定清空全部批改记录吗？此操作不可撤销。')) return;
    state.records = [];
    saveRecords();
    renderResults();
    renderHero();
    renderReport();
    toast('已清空记录');
  });

  /* ===================================================================
   * 密钥（存在本机浏览器，随每次批改请求发给服务端）
   * =================================================================== */
  const health = { fallbackConfigured: false, fallbackMasked: '', fallbackSource: 'none', apiBase: '' };
  const SRC_TEXT = { env: '服务器环境变量', builtin: '服务器内置', none: '无' };
  const KEY_RE = /^sk-[A-Za-z0-9_-]{8,}$/;

  const localKey = () => String(state.settings.apiKey || '').trim();
  const localBase = () => String(state.settings.apiBase || '').trim();
  const effectiveBase = () => localBase() || health.apiBase || '';
  const hasKey = () => KEY_RE.test(localKey()) || health.fallbackConfigured;
  function maskOf(k) {
    const s = String(k || '');
    if (!s) return '';
    if (s.length <= 8) return '****';
    return s.slice(0, 3) + '****' + s.slice(-4);
  }

  function applyKeyUI() {
    const has = hasKey();
    const lk = localKey();

    const pill = $('#api-status');
    pill.classList.toggle('off', !has);
    pill.querySelector('span').textContent = has ? 'AI 已连接' : '未配置密钥';

    $('#set-api').textContent = has ? '正常' : '密钥未配置';
    $('#set-base').textContent = effectiveBase() || '—';
    const baseInput = $('#in-base');
    if (baseInput && document.activeElement !== baseInput) baseInput.value = localBase();
    if (baseInput) baseInput.placeholder = health.apiBase || 'https://apihub.agnes-ai.com/v1';
    if (lk) {
      $('#set-key').textContent = maskOf(lk);
      $('#set-key-src').textContent = '本机浏览器';
    } else if (health.fallbackConfigured) {
      $('#set-key').textContent = health.fallbackMasked;
      $('#set-key-src').textContent = SRC_TEXT[health.fallbackSource] || health.fallbackSource;
    } else {
      $('#set-key').textContent = '未配置';
      $('#set-key-src').textContent = '—';
    }

    const statePill = $('#key-state');
    statePill.textContent = has ? '已配置' : '未配置';
    statePill.className = 'pill' + (has ? '' : ' bad');

    $('#in-key').placeholder = lk ? '已配置，输入新密钥可替换' : 'sk-...';
    $('#btn-key-clear').disabled = !lk;
    $('#key-banner').hidden = has;
    $('#key-msg').className = 'muted small';
    $('#key-msg').textContent = lk
      ? '密钥保存在这台设备的浏览器里（localStorage），只对本设备生效；不会上传到服务器存储。'
      : health.fallbackConfigured
      ? '当前用服务器上的默认密钥。填写自己的密钥可避免消耗他人额度。'
      : '还没有密钥。可在 platform.agnes-ai.com 创建一个，粘贴到这里保存。';
    renderQueue();
  }

  async function checkHealth() {
    try {
      const r = await fetch('/api/health');
      const j = await r.json();
      Object.assign(health, {
        fallbackConfigured: Boolean(j.ok && j.fallbackConfigured),
        fallbackMasked: j.fallbackMasked || '',
        fallbackSource: j.fallbackSource || 'none',
        apiBase: j.apiBase || '',
      });
      applyKeyUI();
    } catch (e) {
      health.fallbackConfigured = false;
      applyKeyUI();
      $('#set-api').textContent = '无法连接服务器';
    }
  }

  function keyMsg(text, kind) {
    const el = $('#key-msg');
    el.textContent = text;
    el.className = 'small ' + (kind === 'err' ? 'msg-err' : kind === 'ok' ? 'msg-ok' : 'muted');
  }

  $('#btn-key-eye').addEventListener('click', () => {
    const inp = $('#in-key');
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    $('#btn-key-eye').textContent = show ? '隐藏' : '显示';
  });

  $('#btn-key-save').addEventListener('click', async () => {
    const typed = $('#in-key').value.trim();
    const key = typed || localKey();
    const apiBase = $('#in-base').value.trim();
    const model = ($('#set-model').value || '').trim();
    if (!key) return keyMsg('请先粘贴密钥', 'err');
    if (!KEY_RE.test(key)) return keyMsg('密钥格式不对，应以 sk- 开头', 'err');
    if (apiBase) {
      try {
        const u = new URL(apiBase);
        if (!/^https?:$/.test(u.protocol)) throw new Error('bad');
      } catch (e) {
        return keyMsg('接口地址格式不对，应形如 https://api.xxx.com/v1', 'err');
      }
    }
    const btn = $('#btn-key-save');
    btn.disabled = true;
    btn.classList.add('busy');
    keyMsg('正在校验…');
    try {
      const r = await fetch('/api/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, apiBase, model }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || '校验失败');
      state.settings.apiKey = key;
      state.settings.apiBase = apiBase;
      if (model) state.settings.model = model;
      saveSettings();
      $('#in-key').value = '';
      applyKeyUI();
      keyMsg(`已保存到本机浏览器，校验通过：${j.masked} · ${j.apiBase}${j.model ? ' · ' + j.model : ''}`, 'ok');
      toast('已保存并验证通过');
    } catch (e) {
      keyMsg(e.message || '保存失败', 'err');
    } finally {
      btn.disabled = false;
      btn.classList.remove('busy');
    }
  });

  $('#btn-base-reset').addEventListener('click', () => {
    state.settings.apiBase = '';
    saveSettings();
    $('#in-base').value = '';
    applyKeyUI();
    keyMsg('接口地址已恢复默认：' + (health.apiBase || 'Agnes AI'), 'ok');
  });

  $('#btn-key-clear').addEventListener('click', () => {
    if (!localKey()) return;
    if (!confirm('确定清除本机保存的密钥吗？清除后将改用服务器上的默认密钥（如果有）。')) return;
    state.settings.apiKey = '';
    saveSettings();
    applyKeyUI();
    keyMsg('已清除本机密钥', 'ok');
    toast('已清除');
  });

  $('#banner-go').addEventListener('click', () => go('settings'));

  /* ===================================================================
   * 初始化
   * =================================================================== */
  /* ===================================================================
   * 登录 / 注册 / 账号
   * =================================================================== */
  async function postJSON(url, body) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    let j = null;
    try {
      j = await r.json();
    } catch (e) {}
    return { ok: r.ok, status: r.status, data: j };
  }

  function showAuth(tab) {
    $('#auth-screen').hidden = false;
    $('#app').classList.add('hidden');
    switchAuthTab(tab || 'login');
  }

  function switchAuthTab(which) {
    $$('.auth-tab').forEach((b) => b.classList.toggle('active', b.dataset.auth === which));
    $('#form-login').classList.toggle('hidden', which !== 'login');
    $('#form-register').classList.toggle('hidden', which !== 'register');
    $('#login-msg').textContent = '';
    $('#reg-msg').textContent = '';
  }

  function authMsg(el, text, kind) {
    const node = $(el);
    node.textContent = text || '';
    node.className = 'auth-msg' + (kind === 'err' ? ' err' : kind === 'ok' ? ' ok' : '');
  }

  function enterApp(user) {
    const guest = Boolean(user && user.guest);
    currentUser = guest ? '' : user.username;
    isAdmin = guest ? false : user.role === 'admin';
    if (guest) migrateGuestData();
    loadUserData();

    $('#auth-screen').hidden = true;
    $('#app').classList.remove('hidden');

    const chip = $('#user-chip');
    chip.hidden = guest;
    chip.textContent = currentUser;
    chip.classList.toggle('admin', isAdmin);
    $('#account-grid').hidden = guest;
    $('#acct-name').textContent = currentUser || '—';
    $('#acct-role-text').textContent = isAdmin ? '管理员' : '普通用户';
    $('#acct-role').textContent = isAdmin ? 'admin' : 'user';
    $('#admin-card').hidden = !isAdmin;

    startApp();
    if (isAdmin && !guest) loadUsersList();
  }

  /** 从「需要登录」版本升级过来时，把 admin 名下的本机数据搬到公共空间 */
  function migrateGuestData() {
    try {
      [LS.roster, LS.records, LS.settings].forEach((k) => {
        if (localStorage.getItem(k) === null) {
          const old = localStorage.getItem(k + '::admin');
          if (old !== null) localStorage.setItem(k, old);
        }
      });
    } catch (e) {}
  }

  function startApp() {
    renderClassSelects();
    renderSettings();
    renderRoster();
    renderResults();
    renderHero();
    renderQueue();
    checkHealth();
    const h = (location.hash || '').replace('#', '');
    if (h && document.getElementById('view-' + h)) go(h, true);
  }

  $$('.auth-tab').forEach((b) => b.addEventListener('click', () => switchAuthTab(b.dataset.auth)));

  $('#form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('#login-user').value.trim();
    const password = $('#login-pass').value;
    if (!username || !password) return authMsg('#login-msg', '请填写用户名和密码', 'err');
    const btn = $('#btn-login');
    btn.disabled = true;
    btn.classList.add('busy');
    try {
      const r = await postJSON('/api/login', { username, password });
      if (!r.ok) throw new Error((r.data && r.data.error) || '登录失败');
      authMsg('#login-msg', '');
      $('#login-pass').value = '';
      enterApp(r.data.user);
      toast('欢迎回来，' + r.data.user.username);
    } catch (err) {
      authMsg('#login-msg', err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.classList.remove('busy');
    }
  });

  $('#form-register').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('#reg-user').value.trim();
    const password = $('#reg-pass').value;
    if (!username || !password) return authMsg('#reg-msg', '请填写用户名和密码', 'err');
    const btn = $('#btn-register');
    btn.disabled = true;
    btn.classList.add('busy');
    try {
      const r = await postJSON('/api/register', { username, password });
      if (!r.ok) throw new Error((r.data && r.data.error) || '注册失败');
      authMsg('#reg-msg', '');
      $('#reg-pass').value = '';
      enterApp(r.data.user);
      toast('注册成功，已登录');
    } catch (err) {
      authMsg('#reg-msg', err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.classList.remove('busy');
    }
  });

  $('#btn-logout').addEventListener('click', async () => {
    if (!confirm('确定退出登录吗？')) return;
    try {
      await fetch('/api/logout', { method: 'POST' });
    } catch (e) {}
    currentUser = '';
    isAdmin = false;
    state.roster = emptyRoster();
    state.records = [];
    state.settings = Object.assign({}, defaultSettings);
    state.queue = [];
    $('#user-chip').hidden = true;
    $('#login-user').value = currentUser;
    $('#login-pass').value = '';
    showAuth('login');
    toast('已退出登录');
  });

  $('#btn-change-pwd').addEventListener('click', async () => {
    const oldPassword = $('#pwd-old').value;
    const newPassword = $('#pwd-new').value;
    const msg = $('#pwd-msg');
    if (!oldPassword || !newPassword) {
      msg.className = 'muted small msg-err';
      msg.textContent = '请填写原密码和新密码';
      return;
    }
    if (newPassword.length < 6) {
      msg.className = 'muted small msg-err';
      msg.textContent = '新密码至少 6 位';
      return;
    }
    const r = await postJSON('/api/password', { oldPassword, newPassword });
    if (r.ok) {
      $('#pwd-old').value = '';
      $('#pwd-new').value = '';
      msg.className = 'muted small msg-ok';
      msg.textContent = '密码已修改';
      toast('密码已修改');
    } else {
      msg.className = 'muted small msg-err';
      msg.textContent = (r.data && r.data.error) || '修改失败';
    }
  });

  /* ---------------- 管理员：用户列表 ---------------- */
  async function loadUsersList() {
    if (!isAdmin) return;
    try {
      const r = await fetch('/api/users');
      if (!r.ok) return;
      const j = await r.json();
      $('#users-count').textContent = j.users.length;
      $('#users-list').innerHTML = j.users
        .map(
          (u) => `<div class="u-item">
            <div class="u-main">
              <b>${esc(u.username)}</b>
              <span class="muted small">${u.role === 'admin' ? '管理员' : '普通用户'} · ${new Date(u.createdAt).toLocaleDateString('zh-CN')}</span>
            </div>
            ${u.role === 'admin' ? '<span class="tag">不可删除</span>' : `<button class="icon-btn" data-del="${esc(u.username)}" aria-label="删除">✕</button>`}
          </div>`
        )
        .join('');
    } catch (e) {}
  }

  $('#users-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-del]');
    if (!btn) return;
    const name = btn.dataset.del;
    if (!confirm(`确定删除用户「${name}」吗？删除后对方将无法登录。`)) return;
    const r = await postJSON('/api/users/delete', { username: name });
    if (r.ok) {
      toast('已删除 ' + name);
      loadUsersList();
    } else {
      toast((r.data && r.data.error) || '删除失败');
    }
  });

  /* ---------------- 启动 ---------------- */
  async function bootstrap() {
    try {
      const r = await fetch('/api/me');
      if (r.ok) {
        const j = await r.json();
        enterApp(j.user);
        return;
      }
    } catch (e) {}
    showAuth('login');
  }

  window.addEventListener('hashchange', () => {
    const v = (location.hash || '').replace('#', '');
    if (v && !$('#app').classList.contains('hidden')) go(v, true);
  });
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  bootstrap();
})();
