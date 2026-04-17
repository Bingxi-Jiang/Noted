const app = document.getElementById('app');

const state = {
  view: 'home',
  sidebarOpen: true,
  folders: [],
  sessions: [],
  activeFolderId: '',
  searchQuery: '',
  currentSession: null,
  currentTranscript: [],
  currentSummaries: [],
  currentNote: null,
  speakerMap: {},
  screenCaptures: [],
  activeTab: 'notes',
  partialTranscript: null,
  micEnabled: false,
  screenEnabled: false,
  showExportModal: false,
  showSpeakerModal: false,
  exportFormat: 'pdf',
  exportDestination: 'download',
  exportBusy: false,
  noteMethods: [],
  selectedNoteMethod: '',
  qaMessages: [],
  qaInput: '',
  loadingSession: false,
  generatingNotes: false,
  askingQuestion: false,
  creatingFolder: false,
  toast: null,
  progress: {
    notes: createProgressState('等待生成'),
    action_items: createProgressState('等待提取'),
    recaps: createProgressState('等待总结'),
    qa: createProgressState('等待提问'),
  },
  recording: {
    ws: null,
    displayStream: null,
    micStream: null,
    audioContext: null,
    processor: null,
    zeroGain: null,
    displaySource: null,
    micSource: null,
    videoEl: null,
    screenTimer: null,
    notePollTimer: null,
  },
};

const titleSaveTimers = new Map();
let renderScheduled = false;
let toastTimer = null;

boot();

async function boot() {
  attachGlobalHandlers();
  await refreshSidebarData();
  scheduleRender();
}

function attachGlobalHandlers() {
  app.addEventListener('click', handleClick);
  app.addEventListener('input', handleInput);
  app.addEventListener('change', handleChange);
  app.addEventListener('submit', handleSubmit);
  window.addEventListener('beforeunload', cleanupAllMedia);
}

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    render();
  });
}

function render() {
  const focusState = captureFocusState();
  const transcriptScrollBefore = app.querySelector('[data-transcript-scroll]');
  const shouldStickTranscriptToBottom = transcriptScrollBefore
    ? transcriptScrollBefore.scrollHeight - transcriptScrollBefore.scrollTop - transcriptScrollBefore.clientHeight < 80
    : true;

  app.innerHTML = `
    <div class="app-shell">
      ${renderSidebar()}
      <main class="main">
        ${!state.sidebarOpen ? '<div style="position:fixed;top:18px;left:18px;z-index:30;"><button class="icon-btn" data-action="toggle-sidebar" title="展开侧边栏">☰</button></div>' : ''}
        ${state.view === 'home' ? renderHome() : renderWorkspace()}
      </main>
      ${state.showExportModal ? renderExportModal() : ''}
      ${state.showSpeakerModal ? renderSpeakerModal() : ''}
      ${state.toast ? renderToast() : ''}
    </div>
  `;

  restoreFocusState(focusState);

  const transcriptScroll = app.querySelector('[data-transcript-scroll]');
  if (transcriptScroll && shouldStickTranscriptToBottom) {
    transcriptScroll.scrollTop = transcriptScroll.scrollHeight;
  }
}

function renderSidebar() {
  const filteredFolders = state.folders.filter((folder) =>
    folder.name.toLowerCase().includes(state.searchQuery.toLowerCase())
  );

  const filteredSessions = state.sessions.filter((session) => {
    const matchesFolder = !state.activeFolderId || session.folder_id === state.activeFolderId;
    const q = state.searchQuery.toLowerCase();
    const matchesQuery = !q || session.title?.toLowerCase().includes(q);
    return matchesFolder && matchesQuery;
  });

  return `
    <aside class="sidebar ${state.sidebarOpen ? '' : 'collapsed'}">
      <div class="sidebar-header">
        <div class="brand-title">Scribe Nexus</div>
        <div class="brand-subtitle">实时转写、AI 笔记、Action Items、Q&A 一体化工作台</div>
        <div class="search-box">
          <span class="search-icon">⌕</span>
          <input data-model="searchQuery" value="${escapeAttr(state.searchQuery)}" placeholder="搜索文件夹 / 记录..." />
        </div>
      </div>

      <div class="sidebar-content">
        <section class="sidebar-section">
          <div class="sidebar-section-title">
            <span>Folders</span>
            <button class="text-btn" data-action="create-folder">+ 新建</button>
          </div>
          <div class="list">
            <button class="list-item ${state.activeFolderId === '' ? 'active' : ''}" data-action="filter-folder" data-folder-id="">
              <span class="folder-icon">🗂️</span>
              <div class="list-copy">
                <div class="list-title">全部记录</div>
                <div class="list-meta">${state.sessions.length} 条 session</div>
              </div>
            </button>
            ${filteredFolders.length === 0 ? `<div class="muted" style="font-size:13px;padding:4px 6px;">暂无文件夹</div>` : filteredFolders.map(renderFolderItem).join('')}
          </div>
        </section>

        <section class="sidebar-section">
          <div class="sidebar-section-title">
            <span>Recent Sessions</span>
            <button class="text-btn" data-action="refresh-data">刷新</button>
          </div>
          <div class="list">
            ${filteredSessions.length === 0 ? `<div class="muted" style="font-size:13px;padding:4px 6px;">暂无符合条件的记录</div>` : filteredSessions.map(renderSessionItem).join('')}
          </div>
        </section>
      </div>

      <div class="sidebar-footer">
        <div class="avatar">JP</div>
        <div class="list-copy">
          <div class="list-title">User</div>
          <div class="list-meta">System audio + mic toggle workflow</div>
        </div>
        <button class="icon-btn" data-action="toggle-sidebar" title="收起侧边栏">≡</button>
      </div>
    </aside>
  `;
}

function renderFolderItem(folder) {
  const color = folder.color || '#7c3aed';
  const active = folder.id === state.activeFolderId;
  const count = state.sessions.filter((s) => s.folder_id === folder.id).length;
  return `
    <button class="list-item ${active ? 'active' : ''}" data-action="filter-folder" data-folder-id="${folder.id}">
      <span class="list-item-dot" style="background:${escapeAttr(color)}"></span>
      <div class="list-copy">
        <div class="list-title">${escapeHtml(folder.name)}</div>
        <div class="list-meta">${count} 条 session</div>
      </div>
    </button>
  `;
}

function renderSessionItem(session) {
  const active = state.currentSession?.id === session.id;
  const icon = session.mode === 'meeting' ? '👥' : '🎓';
  const meta = `${formatDate(session.created_at)} · ${session.mode}`;
  const fullTitle = session.title || 'Untitled Session';
  return `
    <button class="list-item ${active ? 'active' : ''}" data-action="open-session" data-session-id="${session.id}" title="${escapeAttr(fullTitle)}">
      <span class="session-icon">${icon}</span>
      <div class="list-copy">
        <div class="list-title">${escapeHtml(compactTitle(fullTitle, 32))}</div>
        <div class="list-meta">${escapeHtml(meta)}</div>
      </div>
    </button>
  `;
}

function renderHome() {
  return `
    <section class="home-view">
      <div class="home-shell">
        <div class="home-hero">
          <h1>开始新的记录</h1>
          <p>
            这一版已经直接接上后端能力：Session / Folder 管理、WebSocket 实时转写、Meeting 说话人映射、Lecture 概念总结、AI Notes、Action Items、Q&A、导出和可选的 Drive 上传。
          </p>
        </div>

        <div class="mode-grid">
          <article class="mode-card lecture">
            <div class="mode-badge lecture">🎓 Lecture Mode</div>
            <h3>课堂 / 讲座模式</h3>
            <p>重点面向课程、公开讲座、学习记录。界面会优先突出概念边界、结构化笔记和学生视角的 future-facing tasks。</p>
            <div class="feature-list">
              <div class="feature-item"><span class="feature-dot lecture">✓</span><span>Concept recap 自动卡片</span></div>
              <div class="feature-item"><span class="feature-dot lecture">✓</span><span>Cornell / 课程导向笔记生成</span></div>
              <div class="feature-item"><span class="feature-dot lecture">✓</span><span>作业 / quiz / reading 等待办抽取</span></div>
              <div class="feature-item"><span class="feature-dot lecture">✓</span><span>屏幕视觉上下文辅助理解板书 / Slides</span></div>
            </div>
            <button class="mode-cta lecture" data-action="create-session" data-mode="lecture">创建 Lecture Session →</button>
          </article>

          <article class="mode-card meeting">
            <div class="mode-badge meeting">👥 Meeting Mode</div>
            <h3>会议 / 团队模式</h3>
            <p>重点面向 team sync、standup、需求讨论和复盘。界面会优先突出说话人、决策和 owner / deadline 风格的行动项。</p>
            <div class="feature-list">
              <div class="feature-item"><span class="feature-dot meeting">✓</span><span>Speaker diarization + 重命名</span></div>
              <div class="feature-item"><span class="feature-dot meeting">✓</span><span>Meeting minutes 自动生成</span></div>
              <div class="feature-item"><span class="feature-dot meeting">✓</span><span>Owner / deadline / deliverable 视角 action items</span></div>
              <div class="feature-item"><span class="feature-dot meeting">✓</span><span>跨 session / folder 语义问答</span></div>
            </div>
            <button class="mode-cta meeting" data-action="create-session" data-mode="meeting">创建 Meeting Session →</button>
          </article>
        </div>
      </div>
    </section>
  `;
}

function renderWorkspace() {
  const session = state.currentSession;
  if (!session) return renderHome();

  const modeClass = session.mode === 'meeting' ? 'meeting' : 'lecture';
  const isRecording = session.status === 'recording' || session.status === 'starting';
  const tabBadge = countActionItems(state.currentNote?.action_items);

  return `
    <section class="workspace">
      <header class="workspace-header">
        <div class="header-left">
          <button class="icon-btn" data-action="back-home" title="返回主页">←</button>
          <div class="title-wrap">
            <div class="header-meta">
              <span class="pill ${modeClass}">${escapeHtml(session.mode)}</span>
              ${isRecording ? `<span class="recording-indicator"><span class="recording-dot"></span>${session.status === 'starting' ? 'Starting…' : 'Recording'}</span>` : ''}
              ${session.status === 'completed' ? `<span class="chip blue">Completed</span>` : ''}
            </div>
            <input
              data-model="session-title"
              data-session-id="${session.id}"
              value="${escapeAttr(session.title || '')}"
              placeholder="未命名记录"
            />
          </div>
        </div>

        <div class="header-right">
          <div class="control-group">
            <button class="toggle-btn ${state.micEnabled ? 'active' : ''}" data-action="toggle-mic" title="切换麦克风输入" aria-label="切换麦克风输入">
              ${renderMicToggleIcon(state.micEnabled)}
            </button>
            <button class="toggle-btn ${state.screenEnabled ? 'active screen' : ''}" data-action="toggle-screen" title="切换屏幕视觉分析" aria-label="切换屏幕视觉分析">
              ${renderScreenToggleIcon()}
            </button>
          </div>

          ${session.status === 'idle' || session.status === 'active' ? `
            <button class="primary-btn" data-action="start-recording">▶ Start</button>
          ` : ''}

          ${isRecording ? `
            <button class="danger-btn" data-action="stop-recording">■ Stop</button>
          ` : ''}

          ${session.status === 'completed' ? `
            <button class="secondary-btn" data-action="open-export">⬇ 导出</button>
          ` : ''}
        </div>
      </header>

      ${state.screenEnabled ? `
        <div class="screen-banner">
          <div>🖥️ 屏幕视觉分析已开启。系统会基于共享画面定时抓帧，并把截图分析结果注入右侧 AI 面板。</div>
          <div><strong>${state.screenCaptures.length}</strong> 张已分析</div>
        </div>
      ` : ''}

      <div class="workspace-body" data-workspace-body>
        <section class="transcript-panel">
          <div class="panel-header">
            <div>
              <div class="panel-title"><span class="panel-icon">📝</span><span>实时转写</span></div>
              <div class="panel-subtitle">System audio 默认为主输入；Mic 可随时开关。${session.mode === 'meeting' ? 'Meeting 模式下会启用说话人分离。' : 'Lecture 模式下会保留概念脉络。'}</div>
            </div>
            ${session.mode === 'meeting' ? `<button class="text-btn" data-action="open-speakers">管理说话人</button>` : ''}
          </div>

          <div class="transcript-scroll" data-transcript-scroll>
            ${renderTranscriptBody()}
          </div>
        </section>

        <section class="insight-panel">
          <div class="tab-row">
            ${renderTabButton('notes', '📄', 'AI 笔记')}
            ${renderTabButton('action_items', '✅', '待办事项', tabBadge > 0 ? String(tabBadge) : '')}
            ${session.mode === 'lecture' ? renderTabButton('recaps', '💡', '概念总结') : ''}
            ${renderTabButton('qa', '💬', '会话问答')}
          </div>
          <div class="insight-scroll">
            ${renderInsightBody()}
          </div>
        </section>
      </div>
    </section>
  `;
}

function renderTranscriptBody() {
  if (state.loadingSession) {
    return `<div class="empty-state"><div class="empty-state-card"><div class="spinner" style="margin:0 auto 12px"></div><div>正在加载 session 数据…</div></div></div>`;
  }

  if (!state.currentTranscript.length && !state.partialTranscript) {
    return `
      <div class="empty-state">
        <div class="empty-state-card">
          <div class="empty-emoji">🎙️</div>
          <div style="font-weight:700;margin-bottom:8px;">点击 Start 开始实时转写</div>
          <div class="muted">录制时会默认请求系统音频共享；麦克风是可选增强输入，不再和 system audio 互斥。</div>
        </div>
      </div>
    `;
  }

  const lines = state.currentTranscript.map((line) => {
    if (line.type === 'screen_capture') {
      return `
        <div class="screen-card">
          <div class="transcript-time">${formatDuration(line.capture_time || line.start_time || 0)}</div>
          <div class="screen-card-inner">
            <div class="screen-card-title">视觉上下文抓取</div>
            <div class="transcript-text">${escapeHtml(line.description || line.text || '')}</div>
            ${line.extracted_text ? `<div class="muted" style="margin-top:8px;font-size:13px;">OCR / 提取文本：${escapeHtml(line.extracted_text)}</div>` : ''}
          </div>
        </div>
      `;
    }

    const speakerKey = line.speaker || 'speaker_0';
    const label = getSpeakerDisplayName(speakerKey);
    const speakerClass = speakerClassName(speakerKey);
    return `
      <div class="transcript-line">
        <div class="transcript-time">${formatDuration(line.start_time ?? line.start ?? 0)}</div>
        <div class="transcript-bubble">
          <div class="speaker-badge ${speakerClass}">${escapeHtml(label)}</div>
          <div class="transcript-text">${escapeHtml(line.text || '')}</div>
        </div>
      </div>
    `;
  }).join('');

  const partial = state.partialTranscript ? `
    <div class="partial-card">
      <div class="transcript-time">…</div>
      <div class="partial-skeleton"></div>
    </div>
  ` : '';

  return `<div class="transcript-stack">${lines}${partial}</div>`;
}

function renderTabButton(id, icon, label, badge = '') {
  return `
    <button class="tab-btn ${state.activeTab === id ? 'active' : ''}" data-action="switch-tab" data-tab="${id}">
      <span class="tab-icon">${icon}</span>
      <span>${label}</span>
      ${badge ? `<span class="badge">${badge}</span>` : ''}
    </button>
  `;
}

function renderInsightBody() {
  if (state.activeTab === 'notes') return renderNotesTab();
  if (state.activeTab === 'action_items') return renderActionItemsTab();
  if (state.activeTab === 'recaps') return renderRecapsTab();
  return renderQATab();
}

function renderNotesTab() {
  const progress = renderProgressPanel('notes', 'AI 笔记生成状态');
  const methodOptions = (state.noteMethods || []).map((method) => `
    <option value="${escapeAttr(method.id)}" ${state.selectedNoteMethod === method.id ? 'selected' : ''}>${escapeHtml(method.name)}</option>
  `).join('');

  if (!state.currentNote) {
    return `
      ${progress}
      <div class="note-body">
        <div class="note-toolbar">
          <div>
            <div class="note-toolbar-title">${state.currentSession?.mode === 'meeting' ? 'Meeting Minutes' : 'AI Notes'}</div>
            <div class="muted" style="font-size:13px;margin-top:4px;">可以在生成前切换笔记方式。</div>
          </div>
          <div class="note-toolbar-actions">
            <select class="select-input note-method-select" data-model="selectedNoteMethod">
              ${methodOptions}
            </select>
            <button class="primary-btn" data-action="generate-notes" ${state.generatingNotes ? 'disabled' : ''}>生成 AI 笔记</button>
          </div>
        </div>
        <div class="info-callout">
          <div>ℹ️</div>
          <div>当前 session 还没有生成好的 AI 笔记。已有 transcript 的情况下，可以直接用右上角选择的记录方式触发真实后端生成。</div>
        </div>
      </div>
    `;
  }

  return `
    ${progress}
    <div class="note-body">
      <div class="note-toolbar">
        <div>
          <div class="note-toolbar-title">${state.currentSession?.mode === 'meeting' ? 'Meeting Minutes' : 'AI Notes'}</div>
          <div class="muted" style="font-size:13px;margin-top:4px;">当前方法：${escapeHtml(getNoteMethodLabel(state.currentNote.method || state.selectedNoteMethod || 'default'))}</div>
        </div>
        <div class="note-toolbar-actions">
          <select class="select-input note-method-select" data-model="selectedNoteMethod">
            ${methodOptions}
          </select>
          <button class="secondary-btn" data-action="generate-notes" ${state.generatingNotes ? 'disabled' : ''}>重新生成</button>
        </div>
      </div>
      <div class="note-markdown">${markdownToHtml(state.currentNote.content || '')}</div>
    </div>
  `;
}

function renderActionItemsTab() {
  const progress = renderProgressPanel('action_items', 'Action Items 提取状态');

  if (!state.currentNote?.action_items) {
    return `
      ${progress}
      <div class="note-body">
        <div class="info-callout">
          <div>💡</div>
          <div>Action items 会从 transcript + 视觉上下文里独立抽取，优先保留 future-facing task / deadline / owner / reminder 类信息。</div>
        </div>
        <button class="primary-btn" data-action="generate-notes" ${state.generatingNotes ? 'disabled' : ''}>提取待办事项</button>
      </div>
    `;
  }

  const items = parseActionItems(state.currentNote.action_items);
  const log = parseActionLog(state.currentNote.action_items_log);
  const visibleLog = hasVisibleActionLog(log);

  return `
    ${progress}
    <div class="note-body">
      <div class="info-callout">
        <div>🧠</div>
        <div>这些待办来自真实后端抽取，不是前端 mock。Meeting 更偏 owner / deliverable；Lecture 更偏作业 / 考试 / reading / reminders。</div>
      </div>
      <div class="action-list">
        ${items.length ? items.map(renderActionItem).join('') : `<div class="muted">没有识别出明确 action item。</div>`}
      </div>
      ${visibleLog ? `<div class="log-box">${escapeHtml(formatActionLog(log))}</div>` : ''}
    </div>
  `;
}

function renderActionItem(item, index) {
  const chips = [];
  const lower = item.toLowerCase();
  const deadline = extractDeadline(item);
  const owner = extractOwner(item);
  if (deadline) chips.push(`<span class="chip red">Deadline: ${escapeHtml(deadline)}</span>`);
  if (owner) chips.push(`<span class="chip gray">Owner: ${escapeHtml(owner)}</span>`);
  if (!deadline && state.currentSession?.mode === 'lecture') chips.push(`<span class="chip blue">学生 Action</span>`);
  return `
    <label class="action-card">
      <input type="checkbox" data-action="noop" />
      <div>
        <div class="action-title">${escapeHtml(item)}</div>
        <div class="action-meta">${chips.join('')}</div>
      </div>
    </label>
  `;
}

function renderRecapsTab() {
  const recaps = (state.currentSummaries || []).filter((summary) => summary.summary_type === 'concept');
  const progress = renderProgressPanel('recaps', 'Concept Recap 生成状态');

  if (!recaps.length) {
    return `
      ${progress}
      <div class="note-body">
        <div class="info-callout">
          <div>💡</div>
          <div>概念总结来自后端的 concept boundary 检测。如果当前 lecture 还没累计到足够上下文，可以在录制一段后再看，或者手动触发一次 recap。</div>
        </div>
        <button class="primary-btn" data-action="generate-recap" ${isProgressActive('recaps') ? 'disabled' : ''}>生成 Concept Recap</button>
      </div>
    `;
  }

  return `
    ${progress}
    <div class="recaps-grid">
      <button class="secondary-btn" style="width:max-content" data-action="generate-recap" ${isProgressActive('recaps') ? 'disabled' : ''}>+ 继续检测新概念</button>
      ${recaps.map((recap) => `
        <article class="recap-card">
          <div class="recap-head">
            <div class="recap-title">📘 ${escapeHtml(recap.topic_label || 'Concept')}</div>
            <div class="recap-meta">${formatDuration(recap.start_time || 0)} → ${formatDuration(recap.end_time || 0)}</div>
          </div>
          <div class="recap-body note-markdown">${markdownToHtml(recap.summary_text || '')}</div>
        </article>
      `).join('')}
    </div>
  `;
}

function renderQATab() {
  const progress = renderProgressPanel('qa', '会话问答生成状态');
  return `
    <div>
      ${progress}
      <div class="qa-thread">
        ${state.qaMessages.length ? state.qaMessages.map(renderChatMessage).join('') : `
          <div class="chat-row assistant">
            <div class="chat-bubble">
              你好！这里已经接上真实后端问答接口。你可以问当前 session，也可以在有 folder 的情况下自动跨 session 检索。
            </div>
          </div>
        `}
      </div>

      <div class="qa-compose">
        <form class="qa-form" data-action="ask-question-form">
          <textarea data-model="qaInput" placeholder="例如：这次会议最后决定什么时候发 Beta？或者：这节课监督学习和无监督学习的区别是什么？">${escapeHtml(state.qaInput)}</textarea>
          <button class="primary-btn" type="submit" ${state.askingQuestion ? 'disabled' : ''}>
            ${state.askingQuestion ? '思考中…' : '发送'}
          </button>
        </form>
      </div>
    </div>
  `;
}

function renderChatMessage(message) {
  return `
    <div class="chat-row ${message.role}">
      <div class="chat-bubble">
        ${message.role === 'assistant' ? markdownToHtml(message.content) : escapeHtml(message.content)}
        ${message.role === 'assistant' && message.sources?.length ? `
          <div class="chat-sources">
            ${message.sources.map((source) => `
              <div class="source-pill">
                ${source.session_title ? `<strong>${escapeHtml(source.session_title)}</strong> · ` : ''}
                ${source.start_time != null ? `${formatDuration(source.start_time)} · ` : ''}
                ${escapeHtml(trimText(source.text || '', 140))}
              </div>
            `).join('')}
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

function renderExportModal() {
  return `
    <div class="modal-layer" data-action="close-export-layer">
      <div class="modal" data-modal-card="true">
        <div class="modal-head">
          <div>
            <div class="modal-title">导出记录</div>
            <div class="muted" style="margin-top:6px;font-size:13px;">支持本地下载，也支持浏览器侧直传 Google Drive。</div>
          </div>
          <button class="icon-btn" data-action="close-export" ${state.exportBusy ? 'disabled' : ''}>×</button>
        </div>
        <div class="modal-body">
          <div class="field-group">
            <div class="field-label">1. 选择格式</div>
            <div class="option-grid">
              <button type="button" class="export-option ${state.exportFormat === 'pdf' ? 'selected' : ''}" data-action="pick-export-format" data-format="pdf" ${state.exportBusy ? 'disabled' : ''}>
                <div>📄</div>
                <div class="option-title">PDF</div>
                <div class="option-desc">适合阅读、分享、归档</div>
              </button>
              <button type="button" class="export-option ${state.exportFormat === 'docx' ? 'selected' : ''}" data-action="pick-export-format" data-format="docx" ${state.exportBusy ? 'disabled' : ''}>
                <div>📝</div>
                <div class="option-title">DOCX</div>
                <div class="option-desc">适合后续编辑和改写</div>
              </button>
            </div>
          </div>

          <div class="field-group">
            <div class="field-label">2. 选择去向</div>
            <div class="option-grid">
              <button type="button" class="export-option ${state.exportDestination === 'download' ? 'selected' : ''}" data-action="pick-export-destination" data-destination="download" ${state.exportBusy ? 'disabled' : ''}>
                <div>⬇</div>
                <div class="option-title">下载到本地</div>
                <div class="option-desc">直接从后端导出并下载</div>
              </button>
              <button type="button" class="export-option ${state.exportDestination === 'drive' ? 'selected' : ''}" data-action="pick-export-destination" data-destination="drive" ${state.exportBusy ? 'disabled' : ''}>
                <div>☁️</div>
                <div class="option-title">上传 Google Drive</div>
                <div class="option-desc">使用前端 OAuth + Drive File API</div>
              </button>
            </div>
          </div>
          ${state.exportBusy ? `<div class="progress-panel inline">
            <div class="progress-head"><div class="progress-title">正在导出</div><div class="progress-status running">Working</div></div>
            <div class="progress-bar"><div class="progress-fill active" style="width:82%"></div></div>
            <div class="progress-caption">正在准备文件并执行 ${state.exportDestination === 'drive' ? 'Google Drive 上传' : '本地下载'}。</div>
          </div>` : ''}
        </div>
        <div class="modal-foot">
          <button class="ghost-btn" data-action="close-export" ${state.exportBusy ? 'disabled' : ''}>取消</button>
          <button class="primary-btn" data-action="confirm-export" ${state.exportBusy ? 'disabled' : ''}>${state.exportBusy ? '导出中…' : '确认导出'}</button>
        </div>
      </div>
    </div>
  `;
}

function renderSpeakerModal() {
  const keys = Object.keys(state.speakerMap).sort();
  return `
    <div class="modal-layer" data-action="close-speaker-layer">
      <div class="modal" onclick="event.stopPropagation()">
        <div class="modal-head">
          <div>
            <div class="modal-title">说话人映射</div>
            <div class="muted" style="margin-top:6px;font-size:13px;">修改后会写回后端，并同步更新后续 transcript label。</div>
          </div>
          <button class="icon-btn" data-action="close-speakers">×</button>
        </div>
        <div class="modal-body">
          ${keys.length ? keys.map((key) => `
            <div class="speaker-row">
              <div class="speaker-avatar ${speakerClassName(key)}">${escapeHtml(shortSpeakerKey(key))}</div>
              <input class="text-input" data-speaker-key="${key}" value="${escapeAttr(state.speakerMap[key] || key)}" />
            </div>
          `).join('') : `<div class="muted">当前还没有识别到 speaker。Meeting 模式开始录制后会自动生成。</div>`}
        </div>
        <div class="modal-foot">
          <button class="ghost-btn" data-action="close-speakers">取消</button>
          <button class="primary-btn" data-action="save-speakers">保存映射</button>
        </div>
      </div>
    </div>
  `;
}

function renderToast() {
  return `<div class="toast ${state.toast.type === 'error' ? 'error' : ''}">${escapeHtml(state.toast.message)}</div>`;
}

async function handleClick(event) {
  const actionEl = event.target.closest('[data-action]');
  if (!actionEl) return;
  const action = actionEl.dataset.action;

  if (action === 'noop') return;

  try {
    switch (action) {
      case 'toggle-sidebar':
        state.sidebarOpen = !state.sidebarOpen;
        scheduleRender();
        break;
      case 'refresh-data':
        await refreshSidebarData();
        scheduleRender();
        break;
      case 'filter-folder':
        state.activeFolderId = actionEl.dataset.folderId || '';
        scheduleRender();
        break;
      case 'create-folder':
        await createFolderFlow();
        break;
      case 'create-session':
        await createSessionFlow(actionEl.dataset.mode || 'lecture');
        break;
      case 'open-session':
        await openSession(actionEl.dataset.sessionId);
        break;
      case 'back-home':
        await leaveSession();
        break;
      case 'toggle-mic':
        await toggleMic();
        break;
      case 'toggle-screen':
        await toggleScreen();
        break;
      case 'start-recording':
        await startRecording();
        break;
      case 'stop-recording':
        await stopRecording();
        break;
      case 'switch-tab':
        state.activeTab = actionEl.dataset.tab;
        scheduleRender();
        break;
      case 'generate-notes':
        await generateNotes();
        break;
      case 'generate-recap':
        await generateConceptRecap();
        break;
      case 'open-speakers':
        state.showSpeakerModal = true;
        scheduleRender();
        break;
      case 'close-speakers':
      case 'close-speaker-layer':
        state.showSpeakerModal = false;
        scheduleRender();
        break;
      case 'save-speakers':
        await saveSpeakerMappings();
        break;
      case 'open-export':
        state.showExportModal = true;
        scheduleRender();
        break;
      case 'pick-export-format':
        state.exportFormat = actionEl.dataset.format || 'pdf';
        scheduleRender();
        break;
      case 'pick-export-destination':
        state.exportDestination = actionEl.dataset.destination || 'download';
        scheduleRender();
        break;
      case 'close-export':
        if (state.exportBusy) break;
        state.showExportModal = false;
        scheduleRender();
        break;
      case 'close-export-layer':
        if (state.exportBusy || event.target !== actionEl) break;
        state.showExportModal = false;
        scheduleRender();
        break;
      case 'confirm-export':
        await handleExport();
        break;
      default:
        break;
    }
  } catch (err) {
    console.error(err);
    showToast(err.message || '操作失败，请重试。', 'error');
  }
}

function handleInput(event) {
  const model = event.target.dataset.model;
  if (!model) return;

  if (model === 'searchQuery') {
    state.searchQuery = event.target.value;
    scheduleRender();
    return;
  }

  if (model === 'session-title') {
    const id = event.target.dataset.sessionId;
    if (state.currentSession?.id === id) {
      state.currentSession.title = event.target.value;
    }
    debounceSaveTitle(id, event.target.value);
    return;
  }

  if (model === 'qaInput') {
    state.qaInput = event.target.value;
    return;
  }

  if (model === 'selectedNoteMethod') {
    state.selectedNoteMethod = event.target.value;
    return;
  }
}

function handleChange(event) {
  // Reserved for future granular controls.
}

async function handleSubmit(event) {
  const formAction = event.target.dataset.action;
  if (formAction !== 'ask-question-form') return;
  event.preventDefault();
  await askQuestion();
}

async function refreshSidebarData() {
  const [folders, sessions] = await Promise.all([
    api('/api/folders'),
    api('/api/sessions'),
  ]);
  state.folders = folders || [];
  state.sessions = sessions || [];
}

async function createFolderFlow() {
  if (state.creatingFolder) return;
  state.creatingFolder = true;
  const name = window.prompt('新建文件夹名称：', 'New Folder');
  if (!name) {
    state.creatingFolder = false;
    return;
  }
  const folder = await api('/api/folders', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  state.folders.unshift(folder);
  state.activeFolderId = folder.id;
  state.creatingFolder = false;
  showToast('文件夹已创建。');
  scheduleRender();
}

async function createSessionFlow(mode) {
  const payload = {
    title: mode === 'lecture' ? '未命名课程记录' : '未命名会议记录',
    mode,
    folder_id: state.activeFolderId || null,
  };
  const session = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  await refreshSidebarData();
  await openSession(session.id, { keepView: true });
  state.micEnabled = false;
  state.screenEnabled = false;
  showToast(`${mode === 'lecture' ? 'Lecture' : 'Meeting'} session 已创建。`);
}

async function openSession(sessionId, options = {}) {
  await cleanupAllMedia();
  state.loadingSession = true;
  state.view = 'session';
  scheduleRender();

  const [session, chunks, summaries, note, speakers, screenCaptures] = await Promise.all([
    api(`/api/sessions/${sessionId}`),
    api(`/api/sessions/${sessionId}/chunks`),
    api(`/api/sessions/${sessionId}/summaries`),
    api(`/api/sessions/${sessionId}/notes`).catch(() => null),
    api(`/api/sessions/${sessionId}/speaker-map`).catch(() => ({})),
    api(`/api/sessions/${sessionId}/screen-captures`).catch(() => ([])),
  ]);

  const noteMethods = await api(`/api/note-methods?mode=${encodeURIComponent(session?.mode || 'lecture')}`).catch(() => ([]));

  state.currentSession = normalizeSession(session);
  state.currentTranscript = hydrateTranscript(chunks, screenCaptures);
  state.currentSummaries = summaries || [];
  state.currentNote = note || null;
  state.speakerMap = speakers || {};
  state.screenCaptures = screenCaptures || [];
  state.noteMethods = noteMethods || [];
  state.selectedNoteMethod = note?.method || getDefaultNoteMethod(session?.mode, noteMethods);
  state.qaMessages = [];
  state.qaInput = '';
  state.partialTranscript = null;
  state.activeTab = 'notes';
  state.loadingSession = false;

  if (!options.keepView) state.view = 'session';
  scheduleRender();
}

async function leaveSession() {
  await cleanupAllMedia();
  state.view = 'home';
  state.currentSession = null;
  state.currentTranscript = [];
  state.currentSummaries = [];
  state.currentNote = null;
  state.speakerMap = {};
  state.screenCaptures = [];
  state.partialTranscript = null;
  state.qaMessages = [];
  state.qaInput = '';
  state.noteMethods = [];
  state.selectedNoteMethod = '';
  resetAllProgress();
  scheduleRender();
}

async function toggleMic() {
  const next = !state.micEnabled;
  state.micEnabled = next;
  scheduleRender();

  if (state.currentSession?.status === 'recording') {
    if (next) {
      await attachMicStream();
      showToast('麦克风输入已打开。');
    } else {
      detachMicStream();
      showToast('麦克风输入已关闭。');
    }
  }
}

async function toggleScreen() {
  state.screenEnabled = !state.screenEnabled;
  scheduleRender();

  if (state.currentSession?.status === 'recording') {
    if (state.screenEnabled) {
      ensureScreenCaptureLoop();
      showToast('屏幕视觉分析已开启。');
    } else {
      stopScreenCaptureLoop();
      showToast('屏幕视觉分析已关闭。');
    }
  }
}

async function startRecording() {
  const session = state.currentSession;
  if (!session) throw new Error('请先创建或打开一个 session。');
  if (session.status === 'recording' || session.status === 'starting') return;

  session.status = 'starting';
  scheduleRender();

  let displayStream;
  try {
    displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });
  } catch (err) {
    session.status = 'idle';
    scheduleRender();
    throw new Error('需要先授权共享屏幕/标签页，并勾选系统音频。');
  }

  if (!displayStream.getAudioTracks().length) {
    displayStream.getTracks().forEach((track) => track.stop());
    session.status = 'idle';
    scheduleRender();
    throw new Error('当前共享源没有系统音频。请重新选择支持“Share tab audio / 系统音频”的来源。');
  }

  state.recording.displayStream = displayStream;
  state.recording.videoEl = document.createElement('video');
  state.recording.videoEl.muted = true;
  state.recording.videoEl.srcObject = displayStream;
  state.recording.videoEl.playsInline = true;
  state.recording.videoEl.play().catch(() => {});

  const videoTrack = displayStream.getVideoTracks()[0];
  if (videoTrack) {
    videoTrack.addEventListener('ended', async () => {
      if (state.currentSession?.status === 'recording' || state.currentSession?.status === 'starting') {
        showToast('屏幕共享已结束，当前录制也会同步停止。');
        await stopRecording(true);
      }
    });
  }

  await setupAudioPipeline();
  await openSessionSocket();

  if (state.micEnabled) {
    await attachMicStream().catch((err) => {
      console.warn(err);
      showToast('麦克风没有成功接入，当前先继续录系统音频。', 'error');
    });
  }

  if (state.screenEnabled) {
    ensureScreenCaptureLoop();
  }

  resetProgress('notes');
  resetProgress('action_items');
  session.status = 'recording';
  scheduleRender();
  showToast('录制已开始。');
}

async function stopRecording(fromShareEnded = false) {
  const session = state.currentSession;
  if (!session) return;

  if (state.recording.ws && state.recording.ws.readyState === WebSocket.OPEN) {
    state.recording.ws.send(JSON.stringify({ type: 'stop_session' }));
  }

  stopScreenCaptureLoop();
  detachMicStream();
  if (state.recording.displaySource) {
    try { state.recording.displaySource.disconnect(); } catch {}
    state.recording.displaySource = null;
  }
  if (state.recording.processor) {
    try { state.recording.processor.disconnect(); } catch {}
  }
  if (state.recording.zeroGain) {
    try { state.recording.zeroGain.disconnect(); } catch {}
  }
  if (state.recording.audioContext) {
    try { await state.recording.audioContext.close(); } catch {}
    state.recording.audioContext = null;
  }
  if (state.recording.displayStream) {
    state.recording.displayStream.getTracks().forEach((track) => track.stop());
    state.recording.displayStream = null;
  }
  if (state.recording.videoEl) {
    try { state.recording.videoEl.pause(); } catch {}
    state.recording.videoEl.srcObject = null;
    state.recording.videoEl = null;
  }

  session.status = 'completed';
  state.partialTranscript = null;
  startProgress('notes', '正在整理 AI 笔记');
  startProgress('action_items', '正在提取待办事项');
  scheduleRender();

  startNotePolling();
  await refreshSessionData(session.id).catch(() => {});

  if (!fromShareEnded) {
    showToast('录制已停止，正在等待后端生成 notes / action items。');
  }
}

async function cleanupAllMedia() {
  stopScreenCaptureLoop();
  clearInterval(state.recording.notePollTimer);
  state.recording.notePollTimer = null;

  if (state.recording.ws) {
    try { state.recording.ws.close(); } catch {}
    state.recording.ws = null;
  }

  Object.values(state.progress).forEach((progress) => {
    if (progress?.timer) {
      clearInterval(progress.timer);
      progress.timer = null;
      progress.active = false;
    }
  });

  detachMicStream();

  if (state.recording.displaySource) {
    try { state.recording.displaySource.disconnect(); } catch {}
    state.recording.displaySource = null;
  }
  if (state.recording.processor) {
    try { state.recording.processor.disconnect(); } catch {}
    state.recording.processor = null;
  }
  if (state.recording.zeroGain) {
    try { state.recording.zeroGain.disconnect(); } catch {}
    state.recording.zeroGain = null;
  }
  if (state.recording.audioContext) {
    try { await state.recording.audioContext.close(); } catch {}
    state.recording.audioContext = null;
  }
  if (state.recording.displayStream) {
    state.recording.displayStream.getTracks().forEach((track) => track.stop());
    state.recording.displayStream = null;
  }
  if (state.recording.videoEl) {
    try { state.recording.videoEl.pause(); } catch {}
    state.recording.videoEl.srcObject = null;
    state.recording.videoEl = null;
  }
}

async function setupAudioPipeline() {
  const displayStream = state.recording.displayStream;
  if (!displayStream) throw new Error('Display stream 未初始化。');

  const audioContext = new AudioContext();
  await audioContext.resume();

  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const zeroGain = audioContext.createGain();
  zeroGain.gain.value = 0;

  const displaySource = audioContext.createMediaStreamSource(displayStream);
  displaySource.connect(processor);
  processor.connect(zeroGain);
  zeroGain.connect(audioContext.destination);

  processor.onaudioprocess = (e) => {
    const ws = state.recording.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const input = e.inputBuffer.getChannelData(0);
    const pcm16 = downsampleFloatToInt16(input, audioContext.sampleRate, 16000);
    if (pcm16 && pcm16.byteLength) ws.send(pcm16);
  };

  state.recording.audioContext = audioContext;
  state.recording.processor = processor;
  state.recording.zeroGain = zeroGain;
  state.recording.displaySource = displaySource;
}

async function attachMicStream() {
  if (!state.recording.audioContext || !state.recording.processor) return;
  if (state.recording.micStream) return;

  const micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const micSource = state.recording.audioContext.createMediaStreamSource(micStream);
  micSource.connect(state.recording.processor);
  state.recording.micStream = micStream;
  state.recording.micSource = micSource;
}

function detachMicStream() {
  if (state.recording.micSource) {
    try { state.recording.micSource.disconnect(); } catch {}
    state.recording.micSource = null;
  }
  if (state.recording.micStream) {
    state.recording.micStream.getTracks().forEach((track) => track.stop());
    state.recording.micStream = null;
  }
}

async function openSessionSocket() {
  return new Promise((resolve, reject) => {
    const session = state.currentSession;
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${protocol}://${location.host}/ws`);
    ws.binaryType = 'arraybuffer';

    let resolved = false;

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'start_session',
        session_id: session.id,
        session_mode: session.mode,
        summary_mode: 'time',
        summary_interval: 5,
      }));
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        handleSocketMessage(message);
        if (!resolved && message.type === 'session_ready') {
          resolved = true;
          resolve();
        }
      } catch (err) {
        console.warn('WS parse failed:', err);
      }
    };

    ws.onerror = () => {
      if (!resolved) reject(new Error('WebSocket 连接失败。'));
    };

    ws.onclose = () => {
      if (!resolved) reject(new Error('WebSocket 提前关闭。'));
    };

    state.recording.ws = ws;
  });
}

function handleSocketMessage(message) {
  const { type, data } = message;

  if (type === 'partial_transcript') {
    state.partialTranscript = data;
    scheduleRender();
    return;
  }

  if (type === 'final_transcript') {
    state.partialTranscript = null;
    const segments = normalizeFinalTranscriptPayload(data);
    state.currentTranscript.push(...segments);
    scheduleRender();
    return;
  }

  if (type === 'speaker_renamed') {
    if (data?.speaker_key) {
      state.speakerMap[data.speaker_key] = data.display_name;
      scheduleRender();
    }
    return;
  }

  if (type === 'screen_capture_analyzed') {
    const screenItem = { ...data, type: 'screen_capture' };
    state.screenCaptures.push(screenItem);
    state.currentTranscript.push(screenItem);
    scheduleRender();
    return;
  }

  if (type === 'concept_recap') {
    state.currentSummaries.push({
      summary_type: 'concept',
      topic_label: data?.concept_title,
      summary_text: data?.content,
      start_time: data?.start_time,
      end_time: data?.end_time,
    });
    scheduleRender();
    return;
  }

  if (type === 'notes_generated') {
    state.currentNote = data;
    finishProgress('notes', 'AI 笔记已生成');
    finishProgress('action_items', '待办事项已提取');
    clearInterval(state.recording.notePollTimer);
    state.recording.notePollTimer = null;
    scheduleRender();
    showToast('AI 笔记与待办事项已生成。');
    return;
  }

  if (type === 'session_updated') {
    if (data?.title) state.currentSession.title = data.title;
    if (data?.status) state.currentSession.status = normalizeStatus(data.status);
    refreshSidebarData().then(scheduleRender).catch(() => {});
    return;
  }

  if (type === 'error') {
    showToast(data?.message || '后端处理发生错误。', 'error');
    return;
  }
}

function ensureScreenCaptureLoop() {
  stopScreenCaptureLoop();
  if (!state.screenEnabled || !state.recording.videoEl || !state.currentSession) return;

  state.recording.screenTimer = setInterval(async () => {
    if (!state.screenEnabled || !state.recording.videoEl || !state.currentSession) return;

    try {
      const base64 = captureFrameFromVideo(state.recording.videoEl);
      if (!base64) return;

      const recentTranscript = state.currentTranscript
        .slice(-8)
        .filter((item) => item.type !== 'screen_capture')
        .map((item) => `${getSpeakerDisplayName(item.speaker)}: ${item.text}`)
        .join('\n');

      const captureTime = state.currentTranscript.length
        ? state.currentTranscript[state.currentTranscript.length - 1].end_time || state.currentTranscript[state.currentTranscript.length - 1].start_time || 0
        : 0;

      await api(`/api/sessions/${state.currentSession.id}/screen-capture`, {
        method: 'POST',
        body: JSON.stringify({
          image: base64,
          mime_type: 'image/jpeg',
          capture_time: captureTime,
          recent_transcript: recentTranscript,
        }),
      });
    } catch (err) {
      console.warn('screen capture failed', err);
    }
  }, 30000);
}

function stopScreenCaptureLoop() {
  if (state.recording.screenTimer) {
    clearInterval(state.recording.screenTimer);
    state.recording.screenTimer = null;
  }
}

async function refreshSessionData(sessionId) {
  const [chunks, summaries, note, speakers, screenCaptures, latestSession] = await Promise.all([
    api(`/api/sessions/${sessionId}/chunks`),
    api(`/api/sessions/${sessionId}/summaries`),
    api(`/api/sessions/${sessionId}/notes`).catch(() => null),
    api(`/api/sessions/${sessionId}/speaker-map`).catch(() => ({})),
    api(`/api/sessions/${sessionId}/screen-captures`).catch(() => ([])),
    api(`/api/sessions/${sessionId}`).catch(() => state.currentSession),
  ]);

  if (!state.currentSession || state.currentSession.id !== sessionId) return;

  state.currentSession = normalizeSession(latestSession);
  state.currentTranscript = hydrateTranscript(chunks, screenCaptures);
  state.currentSummaries = summaries || [];
  state.currentNote = note || state.currentNote;
  state.speakerMap = speakers || {};
  state.screenCaptures = screenCaptures || [];
  scheduleRender();
}

function startNotePolling() {
  clearInterval(state.recording.notePollTimer);
  if (!state.currentSession) return;

  let attempts = 0;
  state.recording.notePollTimer = setInterval(async () => {
    attempts += 1;
    try {
      const note = await api(`/api/sessions/${state.currentSession.id}/notes`).catch(() => null);
      if (note) {
        state.currentNote = note;
        finishProgress('notes', 'AI 笔记已生成');
        finishProgress('action_items', '待办事项已提取');
        clearInterval(state.recording.notePollTimer);
        state.recording.notePollTimer = null;
        scheduleRender();
        return;
      }
      if (attempts >= 12) {
        clearInterval(state.recording.notePollTimer);
        state.recording.notePollTimer = null;
      }
    } catch {
      clearInterval(state.recording.notePollTimer);
      state.recording.notePollTimer = null;
    }
  }, 5000);
}

async function generateNotes() {
  if (!state.currentSession) return;
  if (!state.currentTranscript.length) throw new Error('当前没有 transcript 数据，暂时无法生成笔记。');

  state.generatingNotes = true;
  startProgress('notes', '正在生成 AI 笔记');
  startProgress('action_items', '正在提取待办事项');
  scheduleRender();
  try {
    const note = await api(`/api/sessions/${state.currentSession.id}/notes/generate`, {
      method: 'POST',
      body: JSON.stringify({ method: state.selectedNoteMethod || undefined }),
    });
    state.currentNote = note;
    if (note?.method) state.selectedNoteMethod = note.method;
    finishProgress('notes', 'AI 笔记已更新');
    finishProgress('action_items', '待办事项已更新');
    showToast('AI 笔记已更新。');
  } catch (err) {
    failProgress('notes', 'AI 笔记生成失败');
    failProgress('action_items', '待办事项提取失败');
    throw err;
  } finally {
    state.generatingNotes = false;
    scheduleRender();
  }
}

async function generateConceptRecap() {
  if (!state.currentSession) return;
  startProgress('recaps', '正在检测概念边界并生成总结');
  try {
    const recap = await api(`/api/sessions/${state.currentSession.id}/concept-recap`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    if (recap?.skipped) {
      resetProgress('recaps', recap.reason || '暂时没有新概念');
      showToast(recap.reason || '暂时没有检测到新的概念边界。');
      return;
    }
    state.currentSummaries.push({
      summary_type: 'concept',
      topic_label: recap.concept_title,
      summary_text: recap.content,
      start_time: recap.start_time,
      end_time: recap.end_time,
    });
    finishProgress('recaps', 'Concept recap 已生成');
    state.activeTab = 'recaps';
    showToast('Concept recap 已生成。');
    scheduleRender();
  } catch (err) {
    failProgress('recaps', 'Concept recap 生成失败');
    throw err;
  }
}

async function saveSpeakerMappings() {
  if (!state.currentSession) return;
  const inputs = [...app.querySelectorAll('[data-speaker-key]')];
  for (const input of inputs) {
    const key = input.dataset.speakerKey;
    const display_name = input.value.trim();
    if (!key || !display_name || display_name === state.speakerMap[key]) continue;
    await api(`/api/sessions/${state.currentSession.id}/speakers/${key}`, {
      method: 'PUT',
      body: JSON.stringify({ display_name }),
    });
    state.speakerMap[key] = display_name;
  }
  state.showSpeakerModal = false;
  scheduleRender();
  showToast('说话人映射已保存。');
}

async function handleExport() {
  if (!state.currentSession || state.exportBusy) return;
  state.exportBusy = true;
  scheduleRender();
  try {
    const blob = await fetchExportBlob(state.exportFormat);
    if (state.exportDestination === 'drive') {
      await uploadBlobToDrive(blob, `${sanitizeFilename(state.currentSession.title || 'session')}.${state.exportFormat}`);
      showToast('文件已上传到 Google Drive。');
    } else {
      downloadBlob(blob, `${sanitizeFilename(state.currentSession.title || 'session')}.${state.exportFormat}`);
      showToast('文件已开始下载。');
    }
    state.showExportModal = false;
  } finally {
    state.exportBusy = false;
    scheduleRender();
  }
}

async function fetchExportBlob(format) {
  const response = await fetch(`/api/sessions/${state.currentSession.id}/export/${format}`);
  if (!response.ok) {
    const error = await safeErrorMessage(response);
    throw new Error(error || '导出失败。请先生成 notes。');
  }
  return response.blob();
}

async function uploadBlobToDrive(blob, filename) {
  if (!window.google?.accounts?.oauth2) {
    throw new Error('Google Identity Services 还没有加载完成。');
  }
  const clientId = window.SCRIBE_CONFIG?.googleDriveClientId;
  if (!clientId) {
    throw new Error('缺少 Google Drive client ID 配置。');
  }

  const accessToken = await new Promise((resolve, reject) => {
    const tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: 'https://www.googleapis.com/auth/drive.file',
      callback: (resp) => {
        if (resp.error) reject(new Error(resp.error));
        else resolve(resp.access_token);
      },
    });
    tokenClient.requestAccessToken({ prompt: 'consent' });
  });

  const metadata = { name: filename };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', blob, filename);

  const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google Drive 上传失败：${text}`);
  }
}

async function askQuestion() {
  if (!state.currentSession) return;
  const question = state.qaInput.trim();
  if (!question) return;

  state.qaMessages.push({ role: 'user', content: question });
  state.qaInput = '';
  state.askingQuestion = true;
  startProgress('qa', '正在生成回答');
  scheduleRender();

  try {
    const response = await api(`/api/sessions/${state.currentSession.id}/ask`, {
      method: 'POST',
      body: JSON.stringify({ question }),
    });
    state.qaMessages.push({
      role: 'assistant',
      content: response.answer || '没有拿到回答。',
      sources: response.sources || [],
    });
    finishProgress('qa', '回答已生成');
  } catch (err) {
    failProgress('qa', '回答生成失败');
    throw err;
  } finally {
    state.askingQuestion = false;
    scheduleRender();
  }
}

function debounceSaveTitle(id, value) {
  clearTimeout(titleSaveTimers.get(id));
  titleSaveTimers.set(id, setTimeout(async () => {
    try {
      await api(`/api/sessions/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ title: value.trim() || 'Untitled Session' }),
      });
      await refreshSidebarData();
      scheduleRender();
    } catch (err) {
      showToast(err.message || '标题保存失败。', 'error');
    }
  }, 500));
}

function hydrateTranscript(chunks = [], screenCaptures = []) {
  const transcriptItems = (chunks || []).map((chunk) => ({
    ...chunk,
    type: 'transcript',
  }));
  const screenItems = (screenCaptures || []).map((capture) => ({
    ...capture,
    type: 'screen_capture',
    start_time: capture.capture_time,
  }));

  return [...transcriptItems, ...screenItems].sort((a, b) => {
    const ta = a.start_time ?? a.capture_time ?? 0;
    const tb = b.start_time ?? b.capture_time ?? 0;
    return ta - tb;
  });
}

function normalizeFinalTranscriptPayload(data = {}) {
  if (data.speakerSegments?.length) {
    return data.speakerSegments
      .filter((segment) => segment.text?.trim())
      .map((segment) => ({
        type: 'transcript',
        text: segment.text,
        start_time: segment.start,
        end_time: segment.end,
        speaker: segment.speaker,
      }));
  }

  if (!data.text?.trim()) return [];
  return [{
    type: 'transcript',
    text: data.text,
    start_time: data.start,
    end_time: data.end,
    speaker: data.speaker,
  }];
}

function normalizeSession(session) {
  return {
    ...session,
    status: normalizeStatus(session?.status),
  };
}

function normalizeStatus(status) {
  if (status === 'completed') return 'completed';
  if (status === 'recording' || status === 'starting') return status;
  return 'idle';
}

function parseActionItems(markdown = '') {
  return String(markdown)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^-\s+/.test(line))
    .map((line) => line.replace(/^-\s+(\[ \]\s+)?/, '').trim())
    .filter(Boolean)
    .filter((line) => !/^none identified$/i.test(line));
}

function countActionItems(markdown = '') {
  return parseActionItems(markdown).length;
}

function parseActionLog(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function formatActionLog(log) {
  const lines = [];
  (log.included || []).forEach((item, index) => {
    lines.push(`[Included ${index + 1}] ${item.timestamp || 'n/a'} | ${item.candidate || ''} | ${item.reason || ''}`);
  });
  (log.excluded || []).forEach((item, index) => {
    lines.push(`[Excluded ${index + 1}] ${item.timestamp || 'n/a'} | ${item.candidate || ''} | ${item.reason || ''}`);
  });
  return lines.join('\n');
}

function hasVisibleActionLog(log) {
  if (!log) return false;
  return Boolean((log.included && log.included.length) || (log.excluded && log.excluded.length));
}

function extractDeadline(text) {
  const patterns = [
    /(下周[一二三四五六日天]?)/,
    /(周[一二三四五六日天])/,
    /(周末)/,
    /(tomorrow|next week|next friday|next monday|friday|monday)/i,
    /(\d{1,2}\/\d{1,2})/,
    /(\d{4}-\d{2}-\d{2})/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return '';
}

function extractOwner(text) {
  const patterns = [
    /Owner:\s*([^,;]+)/i,
    /负责人[:：]\s*([^,;]+)/,
    /Speaker\s*\d+/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1] || match[0];
  }
  return '';
}

function markdownToHtml(markdown = '') {
  const safe = escapeHtml(markdown).replace(/\r/g, '');
  const blocks = safe.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  const htmlBlocks = blocks.map((block) => {
    if (/^#{1,4}\s/.test(block)) {
      const level = block.match(/^#+/)[0].length;
      const content = block.replace(/^#{1,4}\s*/, '');
      return `<h${level}>${inlineMarkdown(content)}</h${level}>`;
    }
    if (/^>\s?/.test(block)) {
      return `<blockquote>${inlineMarkdown(block.replace(/^>\s?/gm, '').replace(/\n/g, '<br>'))}</blockquote>`;
    }
    if (/^(?:-\s+|\*\s+)/m.test(block)) {
      const items = block.split(/\n/).filter(Boolean).map((line) => `<li>${inlineMarkdown(line.replace(/^(?:-\s+|\*\s+)/, ''))}</li>`).join('');
      return `<ul>${items}</ul>`;
    }
    if (/^\d+\.\s+/m.test(block)) {
      const items = block.split(/\n/).filter(Boolean).map((line) => `<li>${inlineMarkdown(line.replace(/^\d+\.\s+/, ''))}</li>`).join('');
      return `<ol>${items}</ol>`;
    }
    return `<p>${inlineMarkdown(block.replace(/\n/g, '<br>'))}</p>`;
  });
  return htmlBlocks.join('');
}

function inlineMarkdown(text = '') {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>');
}

function captureFrameFromVideo(video) {
  if (!video.videoWidth || !video.videoHeight) return '';
  const canvas = document.createElement('canvas');
  const targetWidth = 960;
  const ratio = video.videoHeight / video.videoWidth;
  canvas.width = targetWidth;
  canvas.height = Math.max(540, Math.round(targetWidth * ratio));
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.72);
  return dataUrl.split(',')[1] || '';
}

function downsampleFloatToInt16(buffer, inputSampleRate, outputSampleRate) {
  if (!buffer?.length) return null;
  if (outputSampleRate === inputSampleRate) {
    const out = new Int16Array(buffer.length);
    for (let i = 0; i < buffer.length; i++) {
      const s = Math.max(-1, Math.min(1, buffer[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out.buffer;
  }

  const ratio = inputSampleRate / outputSampleRate;
  const newLength = Math.round(buffer.length / ratio);
  const result = new Int16Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;

  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
      accum += buffer[i];
      count += 1;
    }
    const sample = count ? accum / count : 0;
    const clamped = Math.max(-1, Math.min(1, sample));
    result[offsetResult] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    offsetResult += 1;
    offsetBuffer = nextOffsetBuffer;
  }

  return result.buffer;
}

function getSpeakerDisplayName(key = 'speaker_0') {
  return state.speakerMap[key] || defaultSpeakerName(key);
}

function defaultSpeakerName(key = 'speaker_0') {
  const num = Number(String(key).replace('speaker_', ''));
  if (Number.isFinite(num)) return `Speaker ${num + 1}`;
  return key;
}

function shortSpeakerKey(key = 'speaker_0') {
  const num = Number(String(key).replace('speaker_', ''));
  if (Number.isFinite(num)) return `S${num + 1}`;
  return key.slice(0, 2).toUpperCase();
}

function speakerClassName(key = 'speaker_0') {
  const num = Number(String(key).replace('speaker_', ''));
  const idx = Number.isFinite(num) ? num % 5 : 0;
  return `s${idx}`;
}

function formatDuration(seconds = 0) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function formatDate(value) {
  if (!value) return 'Unknown date';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString();
}

function compactTitle(title = '', max = 32) {
  const value = String(title || '').trim();
  if (!value) return 'Untitled Session';
  return value.length > max ? `${value.slice(0, Math.max(6, max - 1))}…` : value;
}

function getDefaultNoteMethod(mode = 'lecture', methods = []) {
  if (methods?.length) return methods[0].id;
  return mode === 'meeting' ? 'meeting' : 'cornell';
}

function getNoteMethodLabel(id = '') {
  const match = (state.noteMethods || []).find((item) => item.id === id);
  return match?.name || id || 'default';
}

function createProgressState(label = '等待中') {
  return {
    active: false,
    status: 'idle',
    percent: 0,
    label,
    timer: null,
  };
}

function isProgressActive(key) {
  return Boolean(state.progress[key]?.active);
}

function startProgress(key, label) {
  const progress = state.progress[key];
  if (!progress) return;
  clearInterval(progress.timer);
  progress.active = true;
  progress.status = 'running';
  progress.label = label || progress.label;
  progress.percent = Math.max(progress.percent || 0, 8);
  progress.timer = setInterval(() => {
    progress.percent = Math.min(92, progress.percent + (progress.percent < 40 ? 11 : progress.percent < 70 ? 7 : 3));
    scheduleRender();
  }, 500);
}

function finishProgress(key, label) {
  const progress = state.progress[key];
  if (!progress) return;
  clearInterval(progress.timer);
  progress.timer = null;
  progress.active = false;
  progress.status = 'done';
  progress.percent = 100;
  progress.label = label || '已完成';
}

function failProgress(key, label) {
  const progress = state.progress[key];
  if (!progress) return;
  clearInterval(progress.timer);
  progress.timer = null;
  progress.active = false;
  progress.status = 'error';
  progress.label = label || '失败';
  progress.percent = Math.max(progress.percent || 0, 12);
}

function resetProgress(key, label = '等待中') {
  const progress = state.progress[key];
  if (!progress) return;
  clearInterval(progress.timer);
  progress.timer = null;
  progress.active = false;
  progress.status = 'idle';
  progress.percent = 0;
  progress.label = label;
}

function resetAllProgress() {
  Object.keys(state.progress).forEach((key) => resetProgress(key));
}

function renderProgressPanel(key, title) {
  const progress = state.progress[key];
  if (!progress || (progress.status === 'idle' && !progress.active)) {
    return `
      <div class="progress-panel">
        <div class="progress-head">
          <div class="progress-title">${escapeHtml(title)}</div>
          <div class="progress-status idle">Ready</div>
        </div>
        <div class="progress-bar"><div class="progress-fill" style="width:0%"></div></div>
        <div class="progress-caption">等待你触发生成。</div>
      </div>
    `;
  }
  return `
    <div class="progress-panel ${progress.status === 'error' ? 'error' : progress.status === 'done' ? 'done' : ''}">
      <div class="progress-head">
        <div class="progress-title">${escapeHtml(title)}</div>
        <div class="progress-status ${escapeHtml(progress.status)}">${progress.status === 'running' ? 'Working' : progress.status === 'done' ? 'Done' : progress.status === 'error' ? 'Error' : 'Ready'}</div>
      </div>
      <div class="progress-bar"><div class="progress-fill ${progress.active ? 'active' : ''}" style="width:${Math.max(0, Math.min(100, Math.round(progress.percent || 0)))}%"></div></div>
      <div class="progress-caption">${escapeHtml(progress.label || '')}${progress.percent ? ` · ${Math.round(progress.percent)}%` : ''}</div>
    </div>
  `;
}

function renderMicToggleIcon(isOn) {
  return `
    <span class="icon-svg ${isOn ? 'on' : 'off'}" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 1 1-6 0V6a3 3 0 0 1 3-3Z"></path>
        <path d="M19 11a7 7 0 0 1-14 0"></path>
        <path d="M12 18v3"></path>
        <path d="M8 21h8"></path>
        ${isOn ? '' : '<path d="M4 4l16 16"></path>'}
      </svg>
    </span>
  `;
}

function renderScreenToggleIcon() {
  return `
    <span class="icon-svg" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="4" width="18" height="12" rx="2"></rect>
        <path d="M8 20h8"></path>
        <path d="M12 16v4"></path>
      </svg>
    </span>
  `;
}

function captureFocusState() {
  const active = document.activeElement;
  if (!active || !app.contains(active)) return null;
  const stateObj = {
    tagName: active.tagName,
    model: active.dataset?.model || '',
    sessionId: active.dataset?.sessionId || '',
    speakerKey: active.dataset?.speakerKey || '',
    selectionStart: typeof active.selectionStart === 'number' ? active.selectionStart : null,
    selectionEnd: typeof active.selectionEnd === 'number' ? active.selectionEnd : null,
  };
  return stateObj;
}

function restoreFocusState(focusState) {
  if (!focusState) return;
  let selector = '';
  if (focusState.model) selector = `[data-model="${cssEscape(focusState.model)}"]`;
  else if (focusState.speakerKey) selector = `[data-speaker-key="${cssEscape(focusState.speakerKey)}"]`;
  if (!selector) return;

  const target = app.querySelector(selector);
  if (!target) return;
  target.focus({ preventScroll: true });
  if (focusState.sessionId && target.dataset.sessionId !== focusState.sessionId) return;
  if (typeof focusState.selectionStart === 'number' && typeof target.setSelectionRange === 'function') {
    target.setSelectionRange(focusState.selectionStart, focusState.selectionEnd ?? focusState.selectionStart);
  }
}

function cssEscape(value) {
  return String(value || '').replace(/([\"#.;?+*~':^$\[\]()=>|/@])/g, '\\$1');
}


function showToast(message, type = 'info') {
  state.toast = { message, type };
  scheduleRender();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    state.toast = null;
    scheduleRender();
  }, 3400);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function sanitizeFilename(name) {
  return String(name || 'session').replace(/[\\/:*?"<>|]+/g, '').trim() || 'session';
}

function trimText(text, max = 140) {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

async function safeErrorMessage(response) {
  try {
    const json = await response.json();
    return json.error || json.message || response.statusText;
  } catch {
    return response.statusText;
  }
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });

  if (!response.ok) {
    throw new Error(await safeErrorMessage(response));
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return response.json();
  return response.text();
}
