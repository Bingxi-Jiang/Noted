import { uploadToDrive } from './drive-upload.js';

const app = document.getElementById('app');

const ACCOUNT_STORAGE_KEY = 'scribe_accounts_v1';
const ACTIVE_ACCOUNT_STORAGE_KEY = 'scribe_active_account_v1';
const THEME_STORAGE_KEY = 'scribe_theme_v1';
const GOOGLE_TOKEN_STORAGE_KEY = 'scribe_google_tokens_v1';
const GOOGLE_AUTH_SCOPE = 'openid email profile https://www.googleapis.com/auth/drive.file';

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
  expandedScreenCaptures: {},
  activeTab: 'notes',
  partialTranscript: null,
  micEnabled: false,
  screenEnabled: false,
  showExportModal: false,
  showSpeakerModal: false,
  showSettingsModal: false,
  aiSettings: null,
  settingsDraft: null,
  settingsBusy: false,
  exportFormat: 'pdf',
  exportDestination: 'download',
  exportBusy: false,
  noteMethods: [],
  selectedNoteMethod: '',
  qaMessages: [],
  qaInput: '',
  loadingSession: false,
  transcriptExpanded: false,
  generatingNotes: false,
  askingQuestion: false,
  creatingFolder: false,
  showFolderModal: false,
  folderDraft: { name: '', color: '#2962ff' },
  selectionMode: false,
  selectedSessionIds: [],
  sessionContextMenu: { visible: false, sessionId: '', x: 0, y: 0 },
  showMoveModal: false,
  moveTargetFolderId: '',
  moveSessionIds: [],
  dragOverFolderId: '',
  draggingSessionId: '',
  toast: null,
  theme: 'light',
  accounts: [],
  activeAccountId: '',
  authBusy: false,
  authTokens: {},
  emailAccountDraft: { firstName: '', lastName: '', email: '' },
  confirmDialog: null,
  progress: {
    notes: createProgressState('Waiting to generate'),
    action_items: createProgressState('Waiting to extract'),
    recaps: createProgressState('Waiting to summarize'),
    qa: createProgressState('Waiting for a question'),
  },
  recording: {
    sessionId: '',
    sessionMode: 'lecture',
    sessionTitle: '',
    liveTranscript: [],
    liveSummaries: [],
    liveScreenCaptures: [],
    liveSpeakerMap: {},
    partialTranscript: null,
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
let pendingConfirmResolver = null;
let latestOpenSessionToken = 0;
const TRANSCRIPT_PREVIEW_LIMIT = 320;

boot();

async function boot() {
  hydrateClientPreferences();
  applyTheme();
  attachGlobalHandlers();
  await refreshSidebarData();
  await loadModelSettings();
  scheduleRender();
}

function attachGlobalHandlers() {
  app.addEventListener('click', handleClick);
  app.addEventListener('input', handleInput);
  app.addEventListener('change', handleChange);
  app.addEventListener('submit', handleSubmit);
  app.addEventListener('contextmenu', handleContextMenu);
  app.addEventListener('dragstart', handleDragStart);
  app.addEventListener('dragend', handleDragEnd);
  app.addEventListener('dragover', handleDragOver);
  app.addEventListener('drop', handleDrop);
  window.addEventListener('keydown', handleKeyDown);
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
  syncDerivedProgressStates();
  const focusState = captureFocusState();
  const transcriptScrollBefore = app.querySelector('[data-transcript-scroll]');
  const shouldStickTranscriptToBottom = transcriptScrollBefore
    ? transcriptScrollBefore.scrollHeight - transcriptScrollBefore.scrollTop - transcriptScrollBefore.clientHeight < 80
    : true;

  app.innerHTML = `
    <div class="app-shell">
      ${renderSidebar()}
      <main class="main">
        ${!state.sidebarOpen ? '<div class="sidebar-peek-btn"><button class="icon-btn" data-action="toggle-sidebar" title="Expand sidebar">☰</button></div>' : ''}
        ${renderBackgroundRecordingBanner()}
        ${state.view === 'home' ? renderHome() : renderWorkspace()}
      </main>
      ${state.showExportModal ? renderExportModal() : ''}
      ${state.showSpeakerModal ? renderSpeakerModal() : ''}
      ${state.showSettingsModal ? renderSettingsModal() : ''}
      ${state.showFolderModal ? renderFolderModal() : ''}
      ${state.showMoveModal ? renderMoveModal() : ''}
      ${state.sessionContextMenu.visible ? renderSessionContextMenu() : ''}
      ${state.confirmDialog ? renderConfirmModal() : ''}
      ${state.toast ? renderToast() : ''}
    </div>
  `;

  restoreFocusState(focusState);
  autoResizeTitleField();

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
        <div class="brand-title">Noted</div>
        <div class="brand-subtitle">Live transcription, AI notes, action items, and Q&A in one workspace</div>
        <div class="search-box">
          <span class="search-icon">⌕</span>
          <input data-model="searchQuery" value="${escapeAttr(state.searchQuery)}" placeholder="Search folders / sessions..." />
        </div>
      </div>

      <div class="sidebar-content custom-scrollbar">
        <section class="sidebar-section">
          <div class="sidebar-section-title">
            <span>Folders</span>
            <button class="text-btn" data-action="open-create-folder-modal">+ New</button>
          </div>
          <div class="list">
            <button class="list-item ${state.activeFolderId === '' ? 'active' : ''} ${state.dragOverFolderId === '__root__' ? 'drag-hover' : ''}" data-action="filter-folder" data-folder-id="" data-folder-drop-target="true">
              <span class="folder-icon">🗂️</span>
              <div class="list-copy">
                <div class="list-title">All Sessions</div>
                <div class="list-meta">${state.sessions.length} sessions</div>
              </div>
            </button>
            ${filteredFolders.length === 0 ? `<div class="muted" style="font-size:13px;padding:4px 6px;">No folders yet</div>` : filteredFolders.map(renderFolderItem).join('')}
          </div>
        </section>

        <section class="sidebar-section">
          <div class="sidebar-section-title">
            <span>Recent Sessions</span>
            <div class="section-actions">
              <button class="text-btn" data-action="toggle-selection-mode">${state.selectionMode ? 'Done' : 'Select'}</button>
              <button class="text-btn" data-action="refresh-data">Refresh</button>
            </div>
          </div>
          ${renderBatchSessionActions()}
          <div class="list session-list">
            ${filteredSessions.length === 0 ? `<div class="muted" style="font-size:13px;padding:4px 6px;">No matching sessions</div>` : filteredSessions.map(renderSessionItem).join('')}
          </div>
        </section>
      </div>

      ${renderSidebarFooter()}
    </aside>
  `;
}


function renderSidebarFooter() {
  const account = getActiveAccount();
  const displayName = account ? getAccountDisplayName(account) : 'Sign in';
  const meta = account
    ? (account.type === 'google' ? `Google · ${account.email || 'Connected'}` : (account.email || 'Email account'))
    : 'Google / Email login';

  return `
    <div class="sidebar-footer">
      <button class="account-chip" data-action="open-settings" title="Open settings">
        ${renderAccountAvatar(account)}
        <div class="list-copy">
          <div class="list-title">${escapeHtml(displayName)}</div>
          <div class="list-meta">${escapeHtml(meta)}</div>
        </div>
      </button>
      <div class="sidebar-footer-actions">
        <button class="icon-btn" data-action="open-settings" title="Settings">⚙</button>
        <button class="icon-btn" data-action="toggle-sidebar" title="Collapse sidebar">≡</button>
      </div>
    </div>
  `;
}

function renderFolderItem(folder) {
  const color = folder.color || '#7c3aed';
  const active = folder.id === state.activeFolderId;
  const count = state.sessions.filter((s) => s.folder_id === folder.id).length;
  const dragHover = state.dragOverFolderId === folder.id;
  return `
    <button class="list-item ${active ? 'active' : ''} ${dragHover ? 'drag-hover' : ''}" data-action="filter-folder" data-folder-id="${folder.id}" data-folder-drop-target="true">
      <span class="list-item-dot" style="background:${escapeAttr(color)}"></span>
      <div class="list-copy">
        <div class="list-title">${escapeHtml(folder.name)}</div>
        <div class="list-meta">${count} sessions</div>
      </div>
    </button>
  `;
}

function renderSessionItem(session) {
  const active = state.currentSession?.id === session.id;
  const selected = state.selectedSessionIds.includes(session.id);
  const icon = session.mode === 'meeting' ? '👥' : '🎓';
  const meta = `${formatDate(session.created_at)} · ${session.mode}`;
  const fullTitle = session.title || 'Untitled Session';
  return `
    <button class="list-item session-item ${active ? 'active' : ''} ${selected ? 'selected' : ''}" data-action="open-session" data-session-id="${session.id}" data-session-item="true" draggable="true" title="${escapeAttr(fullTitle)}">
      ${state.selectionMode ? `<span class="session-check ${selected ? 'checked' : ''}" data-action="toggle-session-select" data-session-id="${session.id}" aria-hidden="true">${selected ? '✓' : ''}</span>` : ''}
      <span class="session-icon">${icon}</span>
      <div class="list-copy">
        <div class="list-title session-list-title">${escapeHtml(fullTitle)}</div>
        <div class="list-meta">${escapeHtml(meta)}</div>
      </div>
    </button>
  `;
}

function renderBackgroundRecordingBanner() {
  if (!isAnyRecordingActive()) return '';
  const viewingRecordedSession = state.currentSession?.id === state.recording.sessionId;
  const sessionTitle = escapeHtml(state.recording.sessionTitle || getRecordingSessionLabel());
  return `
    <div class="background-recording-banner">
      <div class="background-recording-copy">
        <div class="background-recording-title">${viewingRecordedSession ? 'This session is recording' : 'Background recording in progress'}</div>
        <div class="background-recording-meta">${sessionTitle} · system audio${state.micEnabled ? ' + mic' : ''}${state.screenEnabled ? ' + screenshots' : ''}</div>
      </div>
      <div class="background-recording-actions">
        ${viewingRecordedSession ? '' : `<button class="ghost-btn small" data-action="jump-to-recording-session">Open recording</button>`}
        <button class="danger-btn small" data-action="stop-recording">■ Stop</button>
      </div>
    </div>
  `;
}

function renderHome() {
  return `
    <section class="home-view">
      <div class="home-shell">
        <div class="home-hero">
          <h1>Start a new session</h1>
          <p>
            This build is already wired to the backend: session and folder management, live WebSocket transcription, meeting speaker mapping, lecture concept recaps, AI notes, action items, Q&A, export, and optional Google Drive upload.
          </p>
        </div>

        <div class="mode-grid">
          <article class="mode-card lecture">
            <div class="mode-badge lecture">🎓 Lecture Mode</div>
            <h3>Lecture mode</h3>
            <p>Built for classes, talks, and study sessions. The UI prioritizes concept boundaries, structured notes, and student-facing next steps.</p>
            <div class="feature-list">
              <div class="feature-item"><span class="feature-dot lecture">✓</span><span>Automatic concept recap cards</span></div>
              <div class="feature-item"><span class="feature-dot lecture">✓</span><span>Cornell and class-oriented note generation</span></div>
              <div class="feature-item"><span class="feature-dot lecture">✓</span><span>Homework, quiz, and reading task extraction</span></div>
              <div class="feature-item"><span class="feature-dot lecture">✓</span><span>Screen context to interpret boards and slides</span></div>
            </div>
            <button class="mode-cta lecture" data-action="create-session" data-mode="lecture">Create lecture session →</button>
          </article>

          <article class="mode-card meeting">
            <div class="mode-badge meeting">👥 Meeting Mode</div>
            <h3>Meeting mode</h3>
            <p>Built for team syncs, standups, planning, and retros. The UI prioritizes speakers, decisions, and owner or deadline style action items.</p>
            <div class="feature-list">
              <div class="feature-item"><span class="feature-dot meeting">✓</span><span>Speaker diarization and renaming</span></div>
              <div class="feature-item"><span class="feature-dot meeting">✓</span><span>Automatic meeting minutes</span></div>
              <div class="feature-item"><span class="feature-dot meeting">✓</span><span>Owner, deadline, and deliverable action items</span></div>
              <div class="feature-item"><span class="feature-dot meeting">✓</span><span>Cross-session and cross-folder semantic Q&A</span></div>
            </div>
            <button class="mode-cta meeting" data-action="create-session" data-mode="meeting">Create meeting session →</button>
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
  const isRecording = isSessionActivelyRecording(session.id) || session.status === 'recording' || session.status === 'starting';
  const recordingElsewhere = isAnyRecordingActive() && state.recording.sessionId !== session.id;
  const tabBadge = countActionItems(state.currentNote?.action_items);

  return `
    <section class="workspace">
      <header class="workspace-header">
        <div class="header-left">
          <button class="icon-btn" data-action="back-home" title="Back home">←</button>
          <div class="title-wrap">
            <div class="header-meta">
              <span class="pill ${modeClass}">${escapeHtml(session.mode)}</span>
              ${isRecording ? `<span class="recording-indicator"><span class="recording-dot"></span>${session.status === 'starting' ? 'Starting…' : 'Recording'}</span>` : ''}
              ${session.status === 'completed' ? `<span class="chip blue">Completed</span>` : ''}
            </div>
            <textarea
              data-model="session-title"
              data-session-id="${session.id}"
              placeholder="Untitled session"
              rows="1"
            >${escapeHtml(session.title || '')}</textarea>
          </div>
        </div>

        <div class="header-right">
          <div class="control-group">
            <button class="toggle-btn ${state.micEnabled ? 'active' : ''}" data-action="toggle-mic" title="Toggle microphone input" aria-label="Toggle microphone input">
              ${renderMicToggleIcon(state.micEnabled)}
            </button>
            <button class="toggle-btn ${state.screenEnabled ? 'active screen' : ''}" data-action="toggle-screen" title="Toggle screen analysis" aria-label="Toggle screen analysis">
              ${renderScreenToggleIcon()}
            </button>
          </div>

          ${!isRecording ? `
            <button class="primary-btn" data-action="start-recording" ${recordingElsewhere ? 'disabled' : ''}>▶ Start</button>
          ` : ''}

          ${isRecording ? `
            <button class="danger-btn" data-action="stop-recording">■ Stop</button>
          ` : ''}

          ${session.status === 'completed' ? `
            <button class="secondary-btn" data-action="open-export">⬇ Export</button>
          ` : ''}
        </div>
      </header>

      ${state.screenEnabled && isSessionActivelyRecording(session.id) ? `
        <div class="screen-banner">
          <div>🖥️ Screen analysis is on. The app will capture frames from the shared screen and inject the results into the AI panel.</div>
          <div><strong>${state.screenCaptures.length}</strong> analyzed</div>
        </div>
      ` : ''}

      <div class="workspace-body" data-workspace-body>
        <section class="transcript-panel">
          <div class="panel-header">
            <div>
              <div class="panel-title"><span class="panel-icon">📝</span><span>Live transcript</span></div>
              <div class="panel-subtitle">System audio is the primary input and the mic can be toggled at any time.${session.mode === 'meeting' ? ' Speaker diarization is enabled in meeting mode.' : ' Concept flow is preserved in lecture mode.'}</div>
            </div>
            ${session.mode === 'meeting' ? `<button class="text-btn" data-action="open-speakers">Manage speakers</button>` : ''}
          </div>

          <div class="transcript-scroll" data-transcript-scroll>
            ${renderTranscriptBody()}
          </div>
        </section>

        <section class="insight-panel">
          <div class="tab-row">
            ${renderTabButton('notes', '📄', 'AI Notes')}
            ${renderTabButton('action_items', '✅', 'Action Items', tabBadge > 0 ? String(tabBadge) : '')}
            ${session.mode === 'lecture' ? renderTabButton('recaps', '💡', 'Concept Recaps') : ''}
            ${renderTabButton('qa', '💬', 'Session Q&A')}
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
    return `<div class="empty-state"><div class="empty-state-card"><div class="spinner" style="margin:0 auto 12px"></div><div>Loading session data…</div></div></div>`;
  }

  if (!state.currentTranscript.length && !state.partialTranscript) {
    return `
      <div class="empty-state">
        <div class="empty-state-card">
          <div class="empty-emoji">🎙️</div>
          <div style="font-weight:700;margin-bottom:8px;">Click Start to begin live transcription</div>
          <div class="muted">Recording requests system audio by default. The microphone is now an optional enhancement and is no longer mutually exclusive with system audio.</div>
        </div>
      </div>
    `;
  }

  const totalTranscriptItems = state.currentTranscript.length;
  const transcriptItems = state.transcriptExpanded || totalTranscriptItems <= TRANSCRIPT_PREVIEW_LIMIT
    ? state.currentTranscript
    : state.currentTranscript.slice(-TRANSCRIPT_PREVIEW_LIMIT);
  const hiddenCount = Math.max(0, totalTranscriptItems - transcriptItems.length);

  const lines = transcriptItems.map((line, idx) => {
    if (line.type === 'screen_capture') {
      const captureId = String(line.id || `screen_${line.capture_time || line.start_time || idx}`);
      const expanded = Boolean(state.expandedScreenCaptures[captureId]);
      const rawDesc = String(line.description || line.text || '').replace(/\s+/g, ' ').trim();
      const rawOcr = String(line.extracted_text || '').replace(/\s+/g, ' ').trim();
      const shortDesc = compactVisualContext(rawDesc, 58);
      const shortOcr = compactVisualContext(rawOcr, 72);
      const canExpand = rawDesc.length > shortDesc.length || rawOcr.length > shortOcr.length;
      return `
        <div class="screen-card ${expanded ? 'expanded' : ''}">
          <div class="transcript-time">${formatDuration(line.capture_time || line.start_time || 0)}</div>
          <div class="screen-card-inner">
            <div class="screen-card-head">
              <div class="screen-card-title">Visual context</div>
              ${canExpand ? `<button class="screen-readmore" data-action="toggle-screen-capture" data-capture-id="${escapeAttr(captureId)}">${expanded ? 'Collapse' : 'Read more'}</button>` : ''}
            </div>
            <div class="screen-card-text ${expanded ? 'expanded' : 'collapsed'}">${escapeHtml(expanded ? rawDesc : shortDesc)}</div>
            ${rawOcr ? `<div class="screen-card-subline">OCR: ${escapeHtml(expanded ? rawOcr : shortOcr)}</div>` : ''}
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

  const previewBanner = hiddenCount > 0 ? `
    <div class="transcript-truncation-card">
      <div>
        <strong>Showing the latest ${transcriptItems.length} entries first</strong>
        <div class="muted" style="margin-top:4px;">This session is long. The latest content is rendered first to keep the page responsive. Expand to load the full transcript when needed.</div>
      </div>
      <button class="ghost-btn small" data-action="toggle-full-transcript">${state.transcriptExpanded ? 'Collapse' : 'Show all'}</button>
    </div>
  ` : '';

  return `<div class="transcript-stack">${previewBanner}${lines}${partial}</div>`;
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
  const progress = renderProgressPanel('notes', 'AI notes status');

  if (!state.currentNote) {
    return `
      ${progress}
      <div class="note-body">
        <div class="note-toolbar">
          <div>
            <div class="note-toolbar-title">${state.currentSession?.mode === 'meeting' ? 'Meeting Minutes' : 'AI Notes'}</div>
            <div class="muted" style="font-size:13px;margin-top:4px;">AI notes are manual now. Choose a note style first, then generate them.</div>
          </div>
          <div class="note-toolbar-actions">
            ${renderNoteMethodPicker()}
            <button class="primary-btn" data-action="generate-notes" ${state.generatingNotes ? 'disabled' : ''}>Generate AI notes</button>
          </div>
        </div>
        <div class="info-callout">
          <div>ℹ️</div>
          <div>No AI notes have been generated for this session yet. To save tokens, notes are no longer auto-generated when recording stops. Generate them manually once a transcript exists.</div>
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
          <div class="muted" style="font-size:13px;margin-top:4px;">Current method: ${escapeHtml(getNoteMethodLabel(state.currentNote.method || state.selectedNoteMethod || 'default'))}</div>
        </div>
        <div class="note-toolbar-actions">
          ${renderNoteMethodPicker()}
          <button class="secondary-btn" data-action="generate-notes" ${state.generatingNotes ? 'disabled' : ''}>Regenerate</button>
        </div>
      </div>
      <div class="note-markdown">${markdownToHtml(state.currentNote.content || '')}</div>
    </div>
  `;
}

function renderNoteMethodPicker() {
  const methods = state.noteMethods || [];
  if (!methods.length) return '';
  return `
    <div class="note-method-picker" role="tablist" aria-label="Choose note style">
      ${methods.map((method) => {
        const active = state.selectedNoteMethod === method.id;
        const shortName = method.name.replace(/\s*Method$/i, '').replace(/\s*Minutes$/i, '');
        const hint = method.id === 'cornell' ? 'Q / Notes / Summary' : method.id === 'outline' ? 'Hierarchy / Key Points' : 'Decisions / Sections';
        return `<button class="method-chip ${active ? 'active' : ''}" data-action="select-note-method" data-method-id="${escapeAttr(method.id)}" role="tab" aria-selected="${active ? 'true' : 'false'}">
          <span class="method-chip-title">${escapeHtml(shortName)}</span>
          <span class="method-chip-hint">${escapeHtml(hint)}</span>
        </button>`;
      }).join('')}
    </div>
  `;
}

function renderActionItemsTab() {
  const progress = renderProgressPanel('action_items', 'Action items status');

  if (!state.currentNote || !Object.prototype.hasOwnProperty.call(state.currentNote, 'action_items')) {
    return `
      ${progress}
      <div class="note-body">
        <div class="info-callout">
          <div>💡</div>
          <div>Action items are extracted separately from the transcript and visual context, with priority on future-facing tasks, deadlines, owners, and reminders.</div>
        </div>
        <button class="primary-btn" data-action="generate-notes" ${state.generatingNotes ? 'disabled' : ''}>Extract action items</button>
      </div>
    `;
  }

  const items = parseActionItems(state.currentNote.action_items);

  return `
    ${progress}
    <div class="note-body">
      <div class="info-callout">
        <div>🧠</div>
        <div>Meeting mode emphasizes owners and deliverables; lecture mode emphasizes homework, quizzes, readings, and reminders.</div>
      </div>
      <div class="action-list">
        ${items.length ? items.map(renderActionItem).join('') : `<div class="muted">No clear action items were detected.</div>`}
      </div>
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
  if (!deadline && state.currentSession?.mode === 'lecture') chips.push(`<span class="chip blue">Student action</span>`);
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
  const progress = renderProgressPanel('recaps', 'Concept recap status');

  if (!recaps.length) {
    return `
      ${progress}
      <div class="note-body">
        <div class="info-callout">
          <div>💡</div>
          <div>Concept recaps come from backend concept-boundary detection. If the lecture has not accumulated enough context yet, record a bit longer or trigger a recap manually.</div>
        </div>
        <button class="primary-btn" data-action="generate-recap" ${isProgressActive('recaps') ? 'disabled' : ''}>Generate concept recap</button>
      </div>
    `;
  }

  return `
    ${progress}
    <div class="recaps-grid">
      <button class="secondary-btn" style="width:max-content" data-action="generate-recap" ${isProgressActive('recaps') ? 'disabled' : ''}>+ Detect more concepts</button>
      ${recaps.map((recap) => `
        <article class="recap-card">
          <div class="recap-head">
            <div class="recap-title">📘 ${escapeHtml(recap.topic_label || 'Concept')}</div>
            <div class="recap-meta">${formatDuration(recap.start_time || 0)} → ${formatDuration(recap.end_time || 0)}</div>
          </div>
          <div class="recap-body note-markdown">${markdownToHtml(recap.content || recap.summary || '')}</div>
        </article>
      `).join('')}
    </div>
  `;
}

function renderQATab() {
  const progress = renderProgressPanel('qa', 'Session Q&A status');
  return `
    <div>
      ${progress}
      <div class="qa-thread">
        ${state.qaMessages.length ? state.qaMessages.map(renderChatMessage).join('') : `
          <div class="chat-row assistant">
            <div class="chat-bubble">
              Hi! The live backend Q&A endpoint is already connected. Ask about the current session, or search across sessions automatically when a folder is selected.
            </div>
          </div>
        `}
      </div>

      <div class="qa-compose">
        <form class="qa-form" data-action="ask-question-form">
          <textarea data-model="qaInput" placeholder="For example: When did the team decide to ship beta? Or: What is the difference between supervised and unsupervised learning in this lecture?">${escapeHtml(state.qaInput)}</textarea>
          <button class="primary-btn" type="submit" ${state.askingQuestion ? 'disabled' : ''}>
            ${state.askingQuestion ? 'Thinking…' : 'Send'}
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
            <div class="modal-title">Export session</div>
            <div class="muted" style="margin-top:6px;font-size:13px;">Download locally, or upload directly to Google Drive when the active account is signed in with Google.</div>
          </div>
          <button class="icon-btn" data-action="close-export" ${state.exportBusy ? 'disabled' : ''}>×</button>
        </div>
        <div class="modal-body">
          <div class="field-group">
            <div class="field-label">1. Choose a format</div>
            <div class="option-grid">
              <button type="button" class="export-option ${state.exportFormat === 'pdf' ? 'selected' : ''}" data-action="pick-export-format" data-format="pdf" ${state.exportBusy ? 'disabled' : ''}>
                <div>📄</div>
                <div class="option-title">PDF</div>
                <div class="option-desc">Best for reading, sharing, and archiving</div>
              </button>
              <button type="button" class="export-option ${state.exportFormat === 'docx' ? 'selected' : ''}" data-action="pick-export-format" data-format="docx" ${state.exportBusy ? 'disabled' : ''}>
                <div>📝</div>
                <div class="option-title">DOCX</div>
                <div class="option-desc">Best for editing later</div>
              </button>
            </div>
          </div>

          <div class="field-group">
            <div class="field-label">2. Choose a destination</div>
            <div class="option-grid">
              <button type="button" class="export-option ${state.exportDestination === 'download' ? 'selected' : ''}" data-action="pick-export-destination" data-destination="download" ${state.exportBusy ? 'disabled' : ''}>
                <div>⬇</div>
                <div class="option-title">Download locally</div>
                <div class="option-desc">Export from the backend and download it</div>
              </button>
              <button type="button" class="export-option ${state.exportDestination === 'drive' ? 'selected' : ''}" data-action="pick-export-destination" data-destination="drive" ${state.exportBusy ? 'disabled' : ''}>
                <div>☁️</div>
                <div class="option-title">Upload to Google Drive</div>
                <div class="option-desc">${escapeHtml(getDriveExportDescription())}</div>
              </button>
            </div>
          </div>
          ${!canUseDriveExport() ? `<div class="inline-alert">You are not currently signed in with Google, so Google Drive export is unavailable. Add or switch to a Google account in Settings first.</div>` : ''}
          ${state.exportBusy ? `<div class="progress-panel inline">
            <div class="progress-head"><div class="progress-title">Exporting</div><div class="progress-status running">Working</div></div>
            <div class="progress-bar"><div class="progress-fill active" style="width:82%"></div></div>
            <div class="progress-caption">Preparing the file and running ${state.exportDestination === 'drive' ? 'Google Drive upload' : 'local download'}.</div>
          </div>` : ''}
        </div>
        <div class="modal-foot">
          <button class="ghost-btn" data-action="close-export" ${state.exportBusy ? 'disabled' : ''}>Cancel</button>
          <button class="primary-btn" data-action="confirm-export" ${state.exportBusy ? 'disabled' : ''}>${state.exportBusy ? 'Exporting…' : 'Export'}</button>
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
            <div class="modal-title">Speaker mapping</div>
            <div class="muted" style="margin-top:6px;font-size:13px;">Changes will be written back to the backend and used for later transcript labels.</div>
          </div>
          <button class="icon-btn" data-action="close-speakers">×</button>
        </div>
        <div class="modal-body">
          ${keys.length ? keys.map((key) => `
            <div class="speaker-row">
              <div class="speaker-avatar ${speakerClassName(key)}">${escapeHtml(shortSpeakerKey(key))}</div>
              <input class="text-input" data-speaker-key="${key}" value="${escapeAttr(state.speakerMap[key] || key)}" />
            </div>
          `).join('') : `<div class="muted">No speakers have been detected yet. They will appear automatically after recording starts in meeting mode.</div>`}
        </div>
        <div class="modal-foot">
          <button class="ghost-btn" data-action="close-speakers">Cancel</button>
          <button class="primary-btn" data-action="save-speakers">Save mapping</button>
        </div>
      </div>
    </div>
  `;
}

function renderToast() {
  return `<div class="toast ${state.toast.type === 'error' ? 'error' : ''}">${escapeHtml(state.toast.message)}</div>`;
}

function renderConfirmModal() {
  const dialog = state.confirmDialog;
  if (!dialog) return '';
  return `
    <div class="modal-layer" data-action="close-confirm-layer">
      <div class="modal confirm-modal" data-modal-card="true">
        <div class="modal-head">
          <div>
            <div class="modal-title">${escapeHtml(dialog.title || 'Confirm action')}</div>
            <div class="muted" style="margin-top:6px;font-size:13px;">${escapeHtml(dialog.message || 'Are you sure you want to continue?')}</div>
          </div>
          <button class="icon-btn" data-action="close-confirm">×</button>
        </div>
        <div class="modal-foot">
          <button class="ghost-btn" data-action="close-confirm">${escapeHtml(dialog.cancelLabel || 'Cancel')}</button>
          <button class="${dialog.tone === 'danger' ? 'danger-btn' : 'primary-btn'}" data-action="confirm-dialog-confirm">${escapeHtml(dialog.confirmLabel || 'Confirm')}</button>
        </div>
      </div>
    </div>
  `;
}

function renderBatchSessionActions() {
  if (!state.selectionMode) return '';
  return `
    <div class="batch-bar ${state.selectedSessionIds.length ? 'active' : ''}">
      <div class="batch-copy">Selected ${state.selectedSessionIds.length} sessions</div>
      <div class="batch-actions">
        <button class="ghost-btn small" data-action="open-move-modal" ${state.selectedSessionIds.length ? '' : 'disabled'}>Move</button>
        <button class="ghost-btn small danger-lite" data-action="delete-selected-sessions" ${state.selectedSessionIds.length ? '' : 'disabled'}>Delete</button>
      </div>
    </div>
  `;
}

function renderSessionContextMenu() {
  const menu = state.sessionContextMenu;
  const session = state.sessions.find((item) => item.id === menu.sessionId);
  if (!menu.visible || !session) return '';
  return `
    <div class="context-menu" style="left:${Math.max(12, menu.x)}px;top:${Math.max(12, menu.y)}px;">
      <div class="context-menu-header">${escapeHtml(compactTitle(session.title || 'Untitled Session', 34))}</div>
      <button class="context-menu-item" data-action="context-ai-rename" data-session-id="${session.id}">✨ AI rename</button>
      <button class="context-menu-item" data-action="context-move-session" data-session-id="${session.id}">📁 Move to folder</button>
      <button class="context-menu-item danger" data-action="context-delete-session" data-session-id="${session.id}">🗑 Delete</button>
    </div>
  `;
}

function renderFolderModal() {
  const suggestions = getFolderSuggestions();
  return `
    <div class="modal-layer" data-action="close-folder-modal-layer">
      <div class="modal folder-modal" data-modal-card="true">
        <div class="modal-head">
          <div>
            <div class="modal-title">New folder</div>
            <div class="muted" style="margin-top:6px;font-size:13px;">Give the folder a clearer name and color so drag-and-drop and bulk move actions are easier later.</div>
          </div>
          <button class="icon-btn" data-action="close-folder-modal">×</button>
        </div>
        <div class="modal-body custom-scrollbar">
          <div class="field-group">
            <div class="field-label">Folder name</div>
            <input class="text-input" data-model="folder-name" value="${escapeAttr(state.folderDraft.name || '')}" placeholder="For example: UCI Lectures / Product Weekly / Interview Prep" />
          </div>
          <div class="field-group">
            <div class="field-label">Suggested names</div>
            <div class="suggestion-row">
              ${suggestions.map((name) => `<button class="suggestion-chip" data-action="use-folder-suggestion" data-folder-name="${escapeAttr(name)}">${escapeHtml(name)}</button>`).join('')}
            </div>
          </div>
          <div class="field-group">
            <div class="field-label">Color</div>
            <div class="color-row">
              ${getFolderColorOptions().map((color) => `<button class="color-swatch ${state.folderDraft.color === color ? 'active' : ''}" data-action="set-folder-color" data-color="${escapeAttr(color)}" style="--swatch:${escapeAttr(color)}"></button>`).join('')}
            </div>
          </div>
          <div class="folder-preview">
            <span class="list-item-dot" style="background:${escapeAttr(state.folderDraft.color || '#2962ff')}"></span>
            <div>
              <div class="folder-preview-title">${escapeHtml((state.folderDraft.name || 'New Folder').trim() || 'New Folder')}</div>
              <div class="folder-preview-meta">Folder preview</div>
            </div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="ghost-btn" data-action="close-folder-modal">Cancel</button>
          <button class="primary-btn" data-action="save-folder">Create folder</button>
        </div>
      </div>
    </div>
  `;
}

function renderMoveModal() {
  const selectedCount = state.moveSessionIds.length;
  return `
    <div class="modal-layer" data-action="close-move-modal-layer">
      <div class="modal" data-modal-card="true">
        <div class="modal-head">
          <div>
            <div class="modal-title">Move sessions</div>
            <div class="muted" style="margin-top:6px;font-size:13px;">Move ${selectedCount} session${selectedCount === 1 ? '' : 's'} to a folder, or drag a single session into a folder from the sidebar.</div>
          </div>
          <button class="icon-btn" data-action="close-move-modal">×</button>
        </div>
        <div class="modal-body">
          <div class="move-list">
            <button class="move-option ${state.moveTargetFolderId === '' ? 'active' : ''}" data-action="pick-move-target" data-folder-id="">
              <span class="folder-icon">🗂️</span>
              <div class="list-copy">
                <div class="list-title">All sessions / no folder</div>
                <div class="list-meta">Remove from any folder</div>
              </div>
            </button>
            ${state.folders.map((folder) => `
              <button class="move-option ${state.moveTargetFolderId === folder.id ? 'active' : ''}" data-action="pick-move-target" data-folder-id="${folder.id}">
                <span class="list-item-dot" style="background:${escapeAttr(folder.color || '#2962ff')}"></span>
                <div class="list-copy">
                  <div class="list-title">${escapeHtml(folder.name)}</div>
                  <div class="list-meta">${state.sessions.filter((s) => s.folder_id === folder.id).length} sessions</div>
                </div>
              </button>
            `).join('')}
          </div>
        </div>
        <div class="modal-foot">
          <button class="ghost-btn" data-action="close-move-modal">Cancel</button>
          <button class="primary-btn" data-action="confirm-move-sessions">Move</button>
        </div>
      </div>
    </div>
  `;
}


async function loadModelSettings() {
  try {
    state.aiSettings = await api('/api/settings');
    state.settingsDraft = structuredClone(state.aiSettings);
  } catch (err) { showToast(`Could not load model settings: ${err.message}`, 'error'); }
  scheduleRender();
}

function updateModelSetting(target) {
  const draft = state.settingsDraft;
  if (!draft) return;
  const channel = target.dataset.channel;
  const field = target.dataset.field;
  if (channel) {
    draft[channel][field] = target.value;
    if (field === 'provider') {
      draft[channel].model = state.aiSettings.providers[target.value].defaultModel;
      scheduleRender();
    }
  } else draft[field] = target.value;
}

async function saveModelSettings() {
  if (!state.settingsDraft || state.settingsBusy) return;
  state.settingsBusy = true;
  scheduleRender();
  try {
    state.aiSettings = await api('/api/settings', { method: 'PUT', body: JSON.stringify(state.settingsDraft) });
    state.settingsDraft = structuredClone(state.aiSettings);
    showToast('Settings saved. AI changes apply to new requests; transcription changes apply to the next recording.');
  } finally { state.settingsBusy = false; scheduleRender(); }
}

function renderModelSettings() {
  const draft = state.settingsDraft;
  const info = state.aiSettings;
  if (!draft || !info) return '<section class="settings-section">Model settings could not be loaded. Close and reopen Settings to retry.</section>';
  return `
    <section class="settings-section">
      <div class="settings-section-head"><div>
        <div class="settings-section-title">AI & transcription</div>
        <div class="muted">Choose vision and text separately. Gemini is the default; OpenAI and Claude are optional.</div>
      </div></div>
      <div class="settings-key-status">${Object.values(info.providers).map(p => `<span class="mini-chip ${p.configured ? 'success' : ''}">${escapeHtml(p.label)} · ${p.configured ? 'Key configured' : 'Key missing'}</span>`).join('')}</div>
      <fieldset class="model-fields" ${state.settingsBusy ? 'disabled' : ''}>
      ${['text', 'vision'].map(channel => {
        const selected = draft[channel];
        const provider = info.providers[selected.provider];
        return `<div class="field-row two-col">
          <div class="field-group"><label class="field-label" for="${channel}-provider">${channel === 'text' ? 'Text generation' : 'Screenshot vision'} provider</label>
            <select id="${channel}-provider" class="text-input" data-model="ai-settings-field" data-channel="${channel}" data-field="provider">${Object.entries(info.providers).map(([id, p]) => `<option value="${id}" ${id === selected.provider ? 'selected' : ''}>${escapeHtml(p.label)}</option>`).join('')}</select>
          </div>
          <div class="field-group"><label class="field-label" for="${channel}-model">Model ID</label>
            <input id="${channel}-model" class="text-input" list="${channel}-models" data-model="ai-settings-field" data-channel="${channel}" data-field="model" value="${escapeAttr(selected.model)}" />
            <datalist id="${channel}-models">${provider.models.map(m => `<option value="${escapeAttr(m)}"></option>`).join('')}</datalist>
            <div class="muted">${provider.configured ? 'Ready to use.' : `Add ${escapeHtml(provider.keyEnv)} to .env and restart to use this provider.`}</div>
          </div>
        </div>`;
      }).join('')}
      <div class="field-row two-col">
        <div class="field-group"><label class="field-label" for="deepgram-model">Deepgram model</label>
          <select id="deepgram-model" class="text-input" data-model="ai-settings-field" data-channel="deepgram" data-field="model">${['nova-3', 'nova-2'].map(m => `<option value="${m}" ${draft.deepgram.model === m ? 'selected' : ''}>${m === 'nova-3' ? 'Nova-3 (recommended)' : 'Nova-2'}</option>`).join('')}</select>
        </div>
        <div class="field-group"><label class="field-label" for="deepgram-language">Transcription language</label>
          <select id="deepgram-language" class="text-input" data-model="ai-settings-field" data-channel="deepgram" data-field="language">${[...new Set([draft.deepgram.language, 'en', 'zh', 'zh-TW', 'zh-HK', 'multi', 'es', 'ja', 'fr', 'de', 'ko'])].map(code => `<option value="${escapeAttr(code)}" ${draft.deepgram.language === code ? 'selected' : ''}>${escapeHtml(({en:'English',zh:'Mandarin (Simplified)','zh-TW':'Mandarin (Traditional)','zh-HK':'Cantonese',multi:'Multilingual (10 languages)',es:'Spanish',ja:'Japanese',fr:'French',de:'German',ko:'Korean'})[code] || code)}</option>`).join('')}</select>
        </div>
      </div>
      <div class="muted">${info.deepgramConfigured ? 'Deepgram key configured.' : 'Add DEEPGRAM_API_KEY to .env and restart.'} The “multi” model does not include Chinese; choose Mandarin for Chinese recordings.</div>
      <div class="settings-section-head" style="margin-top:20px"><div><div class="settings-section-title">Google Drive export</div></div></div>
      <div class="field-group"><label class="field-label" for="google-client-id">Google OAuth Web client ID</label>
        <input id="google-client-id" class="text-input" data-model="ai-settings-field" data-field="googleDriveClientId" value="${escapeAttr(draft.googleDriveClientId)}" placeholder="….apps.googleusercontent.com" />
      </div>
      <div class="muted">Save the client ID, then use Continue with Google below. Register <strong>${escapeHtml(location.origin)}</strong> as an authorized JavaScript origin in Google Cloud, enable the Drive API, and add your account as a test user if the OAuth app is in testing.</div>
      </fieldset>
      <div class="settings-actions-row"><button class="primary-btn" data-action="save-model-settings" ${state.settingsBusy ? 'disabled' : ''}>${state.settingsBusy ? 'Saving…' : 'Save AI & Drive settings'}</button></div>
    </section>`;
}

function renderSettingsModal() {
  const activeAccount = getActiveAccount();
  const plans = [
    { id: 'free', name: 'Free', meta: 'Current default', desc: 'Keeps the current core recording, transcription, and export features.' },
    { id: 'pro', name: 'Pro', meta: 'Coming soon', desc: 'Can later add higher limits, more AI workflows, and cross-device sync.' },
    { id: 'team', name: 'Team', meta: 'Coming soon', desc: 'Can later add collaboration, shared spaces, and org-level controls.' },
  ];

  return `
    <div class="modal-layer" data-action="close-settings-layer">
      <div class="modal settings-modal" data-modal-card="true">
        <div class="modal-head">
          <div>
            <div class="modal-title">Settings</div>
            <div class="muted" style="margin-top:6px;font-size:13px;">Choose AI models, configure Google Drive, and manage your preferences.</div>
          </div>
          <button class="icon-btn" data-action="close-settings">×</button>
        </div>
        <div class="modal-body custom-scrollbar settings-body">
          ${renderModelSettings()}
          <section class="settings-section">
            <div class="settings-section-head">
              <div>
                <div class="settings-section-title">Accounts</div>
                <div class="muted">Use either a Google account or an email account. The active account also determines whether direct Google Drive export is available.</div>
              </div>
              ${activeAccount ? `<div class="active-account-pill">Current · ${escapeHtml(getAccountDisplayName(activeAccount))}</div>` : ''}
            </div>

            <div class="settings-account-list">
              ${state.accounts.length ? state.accounts.map((account) => {
                const active = account.id === state.activeAccountId;
                const canDirectDrive = account.type === 'google';
                const secondary = account.email || (account.type === 'google' ? 'Google account' : 'Email account');
                return `
                  <div class="settings-account-card ${active ? 'active' : ''}">
                    <div class="settings-account-main">
                      ${renderAccountAvatar(account)}
                      <div class="list-copy">
                        <div class="list-title">${escapeHtml(getAccountDisplayName(account))}</div>
                        <div class="list-meta" title="${escapeAttr(secondary)}">${escapeHtml(secondary)}</div>
                        <div class="settings-account-tags">
                          <span class="mini-chip">${account.type === 'google' ? 'Google' : 'Email'}</span>
                          <span class="mini-chip ${canDirectDrive ? 'success' : ''}">${canDirectDrive ? 'Drive ready' : 'Local export only'}</span>
                        </div>
                      </div>
                    </div>
                    <div class="settings-account-actions">
                      ${active ? `<span class="mini-chip solid">Active</span>` : `<button class="ghost-btn small" data-action="switch-account" data-account-id="${escapeAttr(account.id)}">Switch</button>`}
                      <button class="ghost-btn small" data-action="remove-account" data-account-id="${escapeAttr(account.id)}">Remove</button>
                    </div>
                  </div>
                `;
              }).join('') : `<div class="empty-state-box">No accounts yet. Add a Google account or create an email account to get started.</div>`}
            </div>

            <div class="settings-actions-row">
              <button class="secondary-btn" data-action="add-google-account" ${state.authBusy ? 'disabled' : ''}>${state.authBusy ? 'Connecting…' : 'Continue with Google'}</button>
            </div>

            <form class="email-account-form" data-action="add-email-account-form">
              <div class="field-row two-col">
                <div class="field-group">
                  <div class="field-label">First name</div>
                  <input class="text-input" data-model="email-first-name" value="${escapeAttr(state.emailAccountDraft.firstName || '')}" placeholder="Paul" />
                </div>
                <div class="field-group">
                  <div class="field-label">Last name</div>
                  <input class="text-input" data-model="email-last-name" value="${escapeAttr(state.emailAccountDraft.lastName || '')}" placeholder="Jiang" />
                </div>
              </div>
              <div class="field-group" style="margin-bottom:0;">
                <div class="field-label">Email</div>
                <input class="text-input" data-model="email-address" value="${escapeAttr(state.emailAccountDraft.email || '')}" placeholder="you@example.com" />
              </div>
              <div class="email-form-foot">
                <div class="muted">With email login, the avatar uses the first letter of the first name plus the last letter of the last name by default.</div>
                <button class="primary-btn" type="submit">Add email account</button>
              </div>
            </form>
          </section>

          <section class="settings-section">
            <div class="settings-section-head">
              <div>
                <div class="settings-section-title">Plan</div>
                <div class="muted">This version includes a presentational plan panel. Payment can be connected later.</div>
              </div>
            </div>
            <div class="plan-grid">
              ${plans.map((plan) => `
                <div class="plan-card ${plan.id === 'free' ? 'active' : ''}">
                  <div class="plan-head">
                    <div class="plan-name">${plan.name}</div>
                    <div class="mini-chip ${plan.id === 'free' ? 'solid' : ''}">${plan.meta}</div>
                  </div>
                  <div class="plan-desc">${plan.desc}</div>
                </div>
              `).join('')}
            </div>
          </section>

          <section class="settings-section">
            <div class="settings-section-head">
              <div>
                <div class="settings-section-title">Theme</div>
                <div class="muted">Light and dark themes are available. Light remains the default.</div>
              </div>
            </div>
            <div class="option-grid theme-grid">
              <button type="button" class="export-option ${state.theme === 'light' ? 'selected' : ''}" data-action="pick-theme" data-theme="light">
                <div>☀️</div>
                <div class="option-title">Light</div>
                <div class="option-desc">Current default theme</div>
              </button>
              <button type="button" class="export-option ${state.theme === 'dark' ? 'selected' : ''}" data-action="pick-theme" data-theme="dark">
                <div>🌙</div>
                <div class="option-title">Dark</div>
                <div class="option-desc">Dark mode</div>
              </button>
            </div>
          </section>
        </div>
        <div class="modal-foot">
          <button class="primary-btn" data-action="close-settings">Done</button>
        </div>
      </div>
    </div>
  `;
}

async function handleClick(event) {
  const actionEl = event.target.closest('[data-action]');
  if (!actionEl) {
    if (state.sessionContextMenu.visible) {
      closeContextMenu();
      scheduleRender();
    }
    return;
  }
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
        closeContextMenu();
        scheduleRender();
        break;
      case 'open-create-folder-modal':
        openCreateFolderModal();
        break;
      case 'close-folder-modal':
      case 'close-folder-modal-layer':
        if (action === 'close-folder-modal-layer' && event.target !== actionEl) break;
        state.showFolderModal = false;
        scheduleRender();
        break;
      case 'use-folder-suggestion':
        state.folderDraft.name = actionEl.dataset.folderName || '';
        scheduleRender();
        break;
      case 'set-folder-color':
        state.folderDraft.color = actionEl.dataset.color || '#2962ff';
        scheduleRender();
        break;
      case 'save-folder':
        await createFolderFlow();
        break;
      case 'create-session':
        await createSessionFlow(actionEl.dataset.mode || 'lecture');
        break;
      case 'toggle-selection-mode':
        state.selectionMode = !state.selectionMode;
        if (!state.selectionMode) state.selectedSessionIds = [];
        scheduleRender();
        break;
      case 'toggle-session-select':
        toggleSessionSelection(actionEl.dataset.sessionId);
        scheduleRender();
        break;
      case 'open-session':
        if (state.selectionMode) {
          toggleSessionSelection(actionEl.dataset.sessionId);
          scheduleRender();
          break;
        }
        await openSession(actionEl.dataset.sessionId);
        break;
      case 'context-ai-rename':
        closeContextMenu();
        await autoRenameSession(actionEl.dataset.sessionId);
        break;
      case 'context-move-session':
        closeContextMenu();
        openMoveModal([actionEl.dataset.sessionId]);
        break;
      case 'context-delete-session':
        closeContextMenu();
        await deleteSessions([actionEl.dataset.sessionId]);
        break;
      case 'open-move-modal':
        openMoveModal(state.selectedSessionIds);
        break;
      case 'close-move-modal':
      case 'close-move-modal-layer':
        if (action === 'close-move-modal-layer' && event.target !== actionEl) break;
        state.showMoveModal = false;
        scheduleRender();
        break;
      case 'pick-move-target':
        state.moveTargetFolderId = actionEl.dataset.folderId || '';
        scheduleRender();
        break;
      case 'confirm-move-sessions':
        await confirmMoveModal();
        break;
      case 'delete-selected-sessions':
        await deleteSessions(state.selectedSessionIds);
        break;
      case 'back-home':
        await leaveSession();
        break;
      case 'jump-to-recording-session':
        if (state.recording.sessionId) await openSession(state.recording.sessionId, { keepView: true });
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
      case 'select-note-method':
        state.selectedNoteMethod = actionEl.dataset.methodId || state.selectedNoteMethod;
        scheduleRender();
        break;
      case 'toggle-screen-capture':
        state.expandedScreenCaptures[actionEl.dataset.captureId || ''] = !state.expandedScreenCaptures[actionEl.dataset.captureId || ''];
        scheduleRender();
        break;
      case 'toggle-full-transcript':
        state.transcriptExpanded = !state.transcriptExpanded;
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
      case 'pick-export-destination': {
        const destination = actionEl.dataset.destination || 'download';
        if (destination === 'drive' && !canUseDriveExport()) {
          state.exportDestination = 'download';
          showToast('The active account is not a Google account, so direct Google Drive export is unavailable. Switch to a Google account in Settings first.', 'error');
          scheduleRender();
          break;
        }
        state.exportDestination = destination;
        scheduleRender();
        break;
      }
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
      case 'open-settings':
        state.showSettingsModal = true;
        await loadModelSettings();
        scheduleRender();
        break;
      case 'save-model-settings':
        await saveModelSettings();
        break;
      case 'close-settings':
        state.showSettingsModal = false;
        scheduleRender();
        break;
      case 'close-settings-layer':
        if (event.target !== actionEl) break;
        state.showSettingsModal = false;
        scheduleRender();
        break;
      case 'close-confirm':
        resolveConfirmation(false);
        break;
      case 'close-confirm-layer':
        if (event.target !== actionEl) break;
        resolveConfirmation(false);
        break;
      case 'confirm-dialog-confirm':
        resolveConfirmation(true);
        break;
      case 'confirm-export':
        await handleExport();
        break;
      case 'add-google-account':
        await addGoogleAccount();
        break;
      case 'switch-account':
        switchActiveAccount(actionEl.dataset.accountId || '');
        break;
      case 'remove-account':
        await removeAccount(actionEl.dataset.accountId || '');
        break;
      case 'pick-theme':
        setTheme(actionEl.dataset.theme || 'light');
        break;
      default:
        break;
    }
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Action failed. Please try again.', 'error');
  }
}

function handleInput(event) {
  const model = event.target.dataset.model;
  if (!model) return;
  if (model === 'ai-settings-field') { updateModelSetting(event.target); return; }

  if (model === 'searchQuery') {
    state.searchQuery = event.target.value;
    scheduleRender();
    return;
  }

  if (model === 'folder-name') {
    state.folderDraft.name = event.target.value;
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

  if (model === 'email-first-name') {
    state.emailAccountDraft.firstName = event.target.value;
    scheduleRender();
    return;
  }

  if (model === 'email-last-name') {
    state.emailAccountDraft.lastName = event.target.value;
    scheduleRender();
    return;
  }

  if (model === 'email-address') {
    state.emailAccountDraft.email = event.target.value;
    scheduleRender();
    return;
  }

}

function handleChange(event) {
  if (event.target.dataset.model === 'ai-settings-field') updateModelSetting(event.target);
}

async function handleSubmit(event) {
  const formAction = event.target.dataset.action;
  if (formAction === 'ask-question-form') {
    event.preventDefault();
    await askQuestion();
    return;
  }
  if (formAction === 'add-email-account-form') {
    event.preventDefault();
    await addEmailAccount();
  }
}

async function refreshSidebarData() {
  const [folders, sessions] = await Promise.all([
    api('/api/folders'),
    api('/api/sessions'),
  ]);
  state.folders = folders || [];
  state.sessions = sessions || [];
  syncSidebarRecordingState();
}

function isAnyRecordingActive() {
  return Boolean(state.recording.sessionId);
}

function isSessionActivelyRecording(sessionId) {
  return Boolean(sessionId && state.recording.sessionId === sessionId);
}

function getRecordingSessionLabel() {
  const matched = state.sessions.find((session) => session.id === state.recording.sessionId);
  return matched?.title || state.recording.sessionTitle || 'Untitled Session';
}

function applyRecordingStateToSession(session) {
  if (!session) return null;
  const normalized = normalizeSession(session);
  if (isSessionActivelyRecording(normalized.id)) {
    normalized.status = 'recording';
  }
  return normalized;
}

function syncSidebarRecordingState() {
  state.sessions = (state.sessions || []).map((session) => {
    if (!session?.id) return session;
    return {
      ...session,
      status: isSessionActivelyRecording(session.id) ? 'recording' : normalizeStatus(session.status),
    };
  });
}

function withTimeout(promise, ms, fallbackMessage = 'Request timed out') {
  let timer = null;
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(fallbackMessage)), ms);
    }),
  ]);
}

function setRecordingCachesFromCurrentSession() {
  if (!state.currentSession) return;
  state.recording.sessionId = state.currentSession.id;
  state.recording.sessionMode = state.currentSession.mode || 'lecture';
  state.recording.sessionTitle = state.currentSession.title || 'Untitled Session';
  state.recording.liveTranscript = [...(state.currentTranscript || [])];
  state.recording.liveSummaries = [...(state.currentSummaries || [])];
  state.recording.liveScreenCaptures = [...(state.screenCaptures || [])];
  state.recording.liveSpeakerMap = { ...(state.speakerMap || {}) };
  state.recording.partialTranscript = state.partialTranscript || null;
}

function syncCurrentSessionWithRecordingCache() {
  if (!state.currentSession || !isSessionActivelyRecording(state.currentSession.id)) return;
  state.currentSession.status = 'recording';
  state.currentTranscript = [...state.recording.liveTranscript];
  state.currentSummaries = [...state.recording.liveSummaries];
  state.currentNote = state.currentNote || null;
  state.speakerMap = { ...state.recording.liveSpeakerMap };
  state.screenCaptures = [...state.recording.liveScreenCaptures];
  state.partialTranscript = state.recording.partialTranscript || null;
}

function clearRecordingSessionState() {
  state.recording.sessionId = '';
  state.recording.sessionMode = 'lecture';
  state.recording.sessionTitle = '';
  state.recording.liveTranscript = [];
  state.recording.liveSummaries = [];
  state.recording.liveScreenCaptures = [];
  state.recording.liveSpeakerMap = {};
  state.recording.partialTranscript = null;
}

async function createFolderFlow() {
  if (state.creatingFolder) return;
  const name = (state.folderDraft.name || '').trim();
  if (!name) {
    showToast('Please enter a folder name.', 'error');
    return;
  }
  state.creatingFolder = true;
  try {
    const folder = await api('/api/folders', {
      method: 'POST',
      body: JSON.stringify({ name, color: state.folderDraft.color || '#2962ff' }),
    });
    state.folders.unshift(folder);
    state.activeFolderId = folder.id;
    state.showFolderModal = false;
    state.folderDraft = { name: '', color: '#2962ff' };
    showToast('Folder created.');
  } finally {
    state.creatingFolder = false;
    scheduleRender();
  }
}

async function createSessionFlow(mode) {
  const payload = {
    title: mode === 'lecture' ? 'Untitled lecture session' : 'Untitled meeting session',
    mode,
    folder_id: state.activeFolderId || null,
  };
  const session = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  await refreshSidebarData();
  await openSession(session.id, { keepView: true });
  if (!isAnyRecordingActive()) {
    state.micEnabled = false;
    state.screenEnabled = false;
  }
  showToast(`${mode === 'lecture' ? 'Lecture' : 'Meeting'} session  created.`);
}

async function openSession(sessionId, options = {}) {
  const openToken = ++latestOpenSessionToken;
  state.loadingSession = true;
  state.transcriptExpanded = false;
  state.view = 'session';
  state.expandedScreenCaptures = {};

  const cached = state.sessions.find((item) => item.id === sessionId);
  if (cached) {
    state.currentSession = applyRecordingStateToSession(cached);
  }
  scheduleRender();

  try {
    const session = await withTimeout(api(`/api/sessions/${sessionId}`), 12000, 'Timed out while loading session details.');
    if (openToken !== latestOpenSessionToken) return;

    state.currentSession = applyRecordingStateToSession(session);
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
    if (!options.keepView) state.view = 'session';
    state.loadingSession = false;
    scheduleRender();

    const [chunksResult, summariesResult, noteResult, speakersResult, screenCapturesResult, noteMethodsResult] = await Promise.allSettled([
      withTimeout(api(`/api/sessions/${sessionId}/chunks`), 12000, 'Timed out while loading the transcript.'),
      withTimeout(api(`/api/sessions/${sessionId}/summaries`), 8000, 'Timed out while loading summaries.'),
      withTimeout(api(`/api/sessions/${sessionId}/notes`).catch(() => null), 5000, 'Timed out while loading notes.'),
      withTimeout(api(`/api/sessions/${sessionId}/speaker-map`).catch(() => ({})), 5000, 'Timed out while loading speaker mapping.'),
      withTimeout(api(`/api/sessions/${sessionId}/screen-captures`).catch(() => ([])), 6000, 'Timed out while loading screen captures.'),
      withTimeout(api(`/api/note-methods?mode=${encodeURIComponent(session?.mode || 'lecture')}`).catch(() => ([])), 4000, 'Timed out while loading note methods.'),
    ]);

    if (openToken !== latestOpenSessionToken) return;

    const chunks = chunksResult.status === 'fulfilled' ? chunksResult.value : [];
    const summaries = summariesResult.status === 'fulfilled' ? summariesResult.value : [];
    const note = noteResult.status === 'fulfilled' ? noteResult.value : null;
    const speakers = speakersResult.status === 'fulfilled' ? speakersResult.value : {};
    const screenCaptures = screenCapturesResult.status === 'fulfilled' ? screenCapturesResult.value : [];
    const noteMethods = noteMethodsResult.status === 'fulfilled' ? noteMethodsResult.value : [];

    state.currentSession = applyRecordingStateToSession(session);
    state.currentTranscript = hydrateTranscript(chunks, screenCaptures);
    state.currentSummaries = summaries || [];
    state.currentNote = note || null;
    state.speakerMap = speakers || {};
    state.screenCaptures = screenCaptures || [];
    state.noteMethods = noteMethods || [];
    state.selectedNoteMethod = note?.method || getDefaultNoteMethod(session?.mode, noteMethods);
    state.partialTranscript = null;
    syncCurrentSessionWithRecordingCache();

    if (chunksResult.status !== 'fulfilled') {
      showToast('This older session has a large transcript, so the blocking load was skipped first. You can still continue using the rest of the page.', 'error');
    }
  } finally {
    if (openToken === latestOpenSessionToken) {
      state.loadingSession = false;
      scheduleRender();
    }
  }
}

async function leaveSession() {
  state.view = 'home';
  state.currentSession = null;
  state.currentTranscript = [];
  state.currentSummaries = [];
  state.currentNote = null;
  state.speakerMap = {};
  state.screenCaptures = [];
  state.expandedScreenCaptures = {};
  state.partialTranscript = null;
  state.qaMessages = [];
  state.qaInput = '';
  state.noteMethods = [];
  state.selectedNoteMethod = '';
  state.transcriptExpanded = false;
  resetAllProgress();
  scheduleRender();
}

async function toggleMic() {
  const next = !state.micEnabled;
  state.micEnabled = next;
  scheduleRender();

  if (isAnyRecordingActive()) {
    if (next) {
      await attachMicStream();
      showToast('Microphone input enabled.');
    } else {
      detachMicStream();
      showToast('Microphone input disabled.');
    }
  }
}

async function toggleScreen() {
  state.screenEnabled = !state.screenEnabled;
  scheduleRender();

  if (isAnyRecordingActive()) {
    if (state.screenEnabled) {
      ensureScreenCaptureLoop();
      showToast('Screen analysis enabled.');
    } else {
      stopScreenCaptureLoop();
      showToast('Screen analysis disabled.');
    }
  }
}

async function startRecording() {
  const session = state.currentSession;
  if (!session) throw new Error('Create or open a session first.');
  if (isAnyRecordingActive() && state.recording.sessionId !== session.id) {
    throw new Error('Another session is already recording in the background. Stop it before starting a new recording.');
  }
  if (isSessionActivelyRecording(session.id) || session.status === 'recording' || session.status === 'starting') return;

  session.status = 'starting';
  setRecordingCachesFromCurrentSession();
  scheduleRender();

  let displayStream;
  try {
    displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });
  } catch (err) {
    session.status = 'idle';
    clearRecordingSessionState();
    scheduleRender();
    throw new Error('Grant screen or tab sharing first and make sure system audio is enabled.');
  }

  if (!displayStream.getAudioTracks().length) {
    displayStream.getTracks().forEach((track) => track.stop());
    session.status = 'idle';
    clearRecordingSessionState();
    scheduleRender();
    throw new Error('The current shared source does not include system audio. Re-select a source that supports shared tab or system audio.');
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
      if (isAnyRecordingActive()) {
        showToast('Screen sharing ended, so the current recording was stopped as well.');
        await stopRecording(true);
      }
    });
  }

  await setupAudioPipeline();
  await openSessionSocket();

  if (state.micEnabled) {
    await attachMicStream().catch((err) => {
      console.warn(err);
      showToast('The microphone could not be attached, so recording will continue with system audio only for now.', 'error');
    });
  }

  if (state.screenEnabled) {
    ensureScreenCaptureLoop();
  }

  resetProgress('notes');
  resetProgress('action_items');
  session.status = 'recording';
  syncSidebarRecordingState();
  scheduleRender();
  showToast('Recording started. It will keep running in the background even if you switch to another session.');
}

async function stopRecording(fromShareEnded = false) {
  const recordedSessionId = state.recording.sessionId;
  if (!recordedSessionId) return;
  const viewingRecordedSession = state.currentSession?.id === recordedSessionId;

  if (state.recording.ws && state.recording.ws.readyState === WebSocket.OPEN) {
    state.recording.ws.send(JSON.stringify({ type: 'stop_session' }));
  }

  stopScreenCaptureLoop();
  clearInterval(state.recording.notePollTimer);
  state.recording.notePollTimer = null;
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
  if (state.recording.ws) {
    try { state.recording.ws.close(); } catch {}
    state.recording.ws = null;
  }

  clearRecordingSessionState();
  syncSidebarRecordingState();

  if (viewingRecordedSession && state.currentSession) {
    state.currentSession.status = 'completed';
    state.partialTranscript = null;
  }

  await refreshSidebarData().catch(() => {});
  if (viewingRecordedSession) {
    await refreshSessionData(recordedSessionId).catch(() => {});
  }
  scheduleRender();

  if (!fromShareEnded) {
    showToast('Recording stopped. AI notes remain manual, while concept recaps are still detected automatically.');
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
  clearRecordingSessionState();
  syncSidebarRecordingState();
}

async function setupAudioPipeline() {
  const displayStream = state.recording.displayStream;
  if (!displayStream) throw new Error('Display stream is not initialized.');

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
    const sessionId = state.recording.sessionId;
    const sessionMode = state.recording.sessionMode || state.currentSession?.mode || 'lecture';
    if (!sessionId) {
      reject(new Error('The recording session is not initialized yet.'));
      return;
    }
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${protocol}://${location.host}/ws`);
    ws.binaryType = 'arraybuffer';

    let resolved = false;

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'start_session',
        session_id: sessionId,
        session_mode: sessionMode,
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
        if (!resolved && message.type === 'error') {
          resolved = true;
          reject(new Error(message.data?.message || 'Transcription could not start.'));
        }
      } catch (err) {
        console.warn('WS parse failed:', err);
      }
    };

    ws.onerror = () => {
      if (!resolved) reject(new Error('WebSocket connection failed.'));
    };

    ws.onclose = () => {
      if (!resolved) reject(new Error('WebSocket closed early.'));
    };

    state.recording.ws = ws;
  });
}

function handleSocketMessage(message) {
  const { type, data } = message;
  const viewingRecordingSession = state.currentSession?.id && isSessionActivelyRecording(state.currentSession.id);

  if (type === 'partial_transcript') {
    state.recording.partialTranscript = data;
    if (viewingRecordingSession) {
      state.partialTranscript = data;
      scheduleRender();
    }
    return;
  }

  if (type === 'final_transcript') {
    const segments = normalizeFinalTranscriptPayload(data);
    state.recording.partialTranscript = null;
    if (segments.length) {
      state.recording.liveTranscript.push(...segments);
    }
    if (viewingRecordingSession) {
      state.partialTranscript = null;
      state.currentTranscript.push(...segments);
      scheduleRender();
    }
    return;
  }

  if (type === 'speaker_renamed') {
    if (data?.speaker_key) {
      state.recording.liveSpeakerMap[data.speaker_key] = data.display_name;
      if (viewingRecordingSession) {
        state.speakerMap[data.speaker_key] = data.display_name;
        scheduleRender();
      }
    }
    return;
  }

  if (type === 'screen_capture_analyzed') {
    const screenItem = { ...data, type: 'screen_capture' };
    state.recording.liveScreenCaptures.push(screenItem);
    state.recording.liveTranscript.push(screenItem);
    if (viewingRecordingSession) {
      state.screenCaptures.push(screenItem);
      state.currentTranscript.push(screenItem);
      scheduleRender();
    }
    return;
  }

  if (type === 'concept_recap') {
    const recapItem = {
      summary_type: 'concept',
      topic_label: data?.concept_title,
      summary_text: data?.content,
      start_time: data?.start_time,
      end_time: data?.end_time,
    };
    state.recording.liveSummaries.push(recapItem);
    if (viewingRecordingSession) {
      state.currentSummaries.push(recapItem);
      scheduleRender();
    }
    return;
  }

  if (type === 'notes_generated') {
    if (viewingRecordingSession) {
      state.currentNote = data;
      finishProgress('notes', 'AI notes generated');
      finishProgress('action_items', 'Action items extracted');
      clearInterval(state.recording.notePollTimer);
      state.recording.notePollTimer = null;
      scheduleRender();
      showToast('AI notes and action items generated.');
    }
    return;
  }

  if (type === 'session_updated') {
    if (data?.title) state.recording.sessionTitle = data.title;
    if (state.currentSession && state.currentSession.id === state.recording.sessionId) {
      if (data?.title) state.currentSession.title = data.title;
      if (data?.status) state.currentSession.status = normalizeStatus(data.status);
    }
    refreshSidebarData().then(scheduleRender).catch(() => {});
    return;
  }

  if (type === 'session_stopped' || type === 'transcriber_closed') {
    return;
  }

  if (type === 'error') {
    showToast(data?.message || 'A backend error occurred.', 'error');
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

  state.currentSession = applyRecordingStateToSession(latestSession);
  state.currentTranscript = hydrateTranscript(chunks, screenCaptures);
  state.currentSummaries = summaries || [];
  state.currentNote = note || state.currentNote;
  state.speakerMap = speakers || {};
  state.screenCaptures = screenCaptures || [];
  state.expandedScreenCaptures = {};
  syncCurrentSessionWithRecordingCache();
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
        finishProgress('notes', 'AI notes generated');
        finishProgress('action_items', 'Action items extracted');
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
  if (!state.currentTranscript.length) throw new Error('There is no transcript data yet, so notes cannot be generated right now.');

  state.generatingNotes = true;
  startProgress('notes', 'Generating AI notes');
  startProgress('action_items', 'Extracting action items');
  scheduleRender();
  try {
    const note = await api(`/api/sessions/${state.currentSession.id}/notes/generate`, {
      method: 'POST',
      body: JSON.stringify({ method: state.selectedNoteMethod || undefined }),
    });
    state.currentNote = note;
    if (note?.method) state.selectedNoteMethod = note.method;
    finishProgress('notes', 'AI notes updated');
    finishProgress('action_items', 'Action items updated');
    showToast('AI notes updated.');
  } catch (err) {
    failProgress('notes', 'AI notes failed');
    failProgress('action_items', 'Action item extraction failed');
    throw err;
  } finally {
    state.generatingNotes = false;
    scheduleRender();
  }
}

async function generateConceptRecap() {
  if (!state.currentSession) return;
  startProgress('recaps', 'Detecting concept boundaries and generating a recap');
  try {
    const recap = await api(`/api/sessions/${state.currentSession.id}/concept-recap`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    if (recap?.skipped) {
      resetProgress('recaps', recap.reason || 'No new concepts yet');
      showToast(recap.reason || 'No new concept boundaries detected yet.');
      return;
    }
    state.currentSummaries.push({
      summary_type: 'concept',
      topic_label: recap.concept_title,
      summary_text: recap.content,
      start_time: recap.start_time,
      end_time: recap.end_time,
    });
    finishProgress('recaps', 'Concept recap generated');
    state.activeTab = 'recaps';
    showToast('Concept recap generated.');
    scheduleRender();
  } catch (err) {
    failProgress('recaps', 'Concept recap failed');
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
  showToast('Speaker mapping saved.');
}

async function handleExport() {
  if (!state.currentSession || state.exportBusy) return;
  state.exportBusy = true;
  scheduleRender();
  try {
    // Request OAuth from the Export click, before awaiting file generation.
    const accessToken = state.exportDestination === 'drive' ? await ensureGoogleDriveAccessToken(getActiveAccount()) : null;
    const blob = await fetchExportBlob(state.exportFormat);
    if (state.exportDestination === 'drive') {
      await uploadBlobToDrive(blob, `${sanitizeFilename(state.currentSession.title || 'session')}.${state.exportFormat}`, accessToken);
      showToast('The file was uploaded to Google Drive.');
    } else {
      downloadBlob(blob, `${sanitizeFilename(state.currentSession.title || 'session')}.${state.exportFormat}`);
      showToast('The download has started.');
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
    throw new Error(error || 'Export failed. Generate notes first.');
  }
  return response.blob();
}

async function uploadBlobToDrive(blob, filename, accessToken) {
  try { return await uploadToDrive(blob, filename, accessToken); }
  catch (err) {
    if (err.status === 401) {
      delete state.authTokens[state.activeAccountId];
      persistAuthTokens();
    }
    throw err;
  }
}

async function askQuestion() {
  if (!state.currentSession) return;
  const question = state.qaInput.trim();
  if (!question) return;

  state.qaMessages.push({ role: 'user', content: question });
  state.qaInput = '';
  state.askingQuestion = true;
  startProgress('qa', 'Generating answer');
  scheduleRender();

  try {
    const response = await api(`/api/sessions/${state.currentSession.id}/ask`, {
      method: 'POST',
      body: JSON.stringify({ question }),
    });
    state.qaMessages.push({
      role: 'assistant',
      content: response.answer || 'No answer was returned.',
      sources: response.sources || [],
    });
    finishProgress('qa', 'Answer generated');
  } catch (err) {
    failProgress('qa', 'Answer failed');
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
      showToast(err.message || 'Failed to save the title.', 'error');
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

function compactVisualContext(text = '', max = 64) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  return value.length > max ? `${value.slice(0, Math.max(10, max - 1))}…` : value;
}

function renderMathAwareText(text = '') {
  const placeholders = [];
  let working = String(text || '');
  working = working.replace(/\$\$([\s\S]+?)\$\$/g, (_, expr) => {
    const token = `%%MATH${placeholders.length}%%`;
    placeholders.push(`<span class="math-block">${latexToReadableMath(expr)}</span>`);
    return token;
  });
  working = working.replace(/(^|[^\\])\$([^$\n]+?)\$/g, (_, prefix, expr) => {
    const token = `%%MATH${placeholders.length}%%`;
    placeholders.push(`<span class="math-inline">${latexToReadableMath(expr)}</span>`);
    return `${prefix}${token}`;
  });

  working = working
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>');

  return working.replace(/%%MATH(\d+)%%/g, (_, index) => placeholders[Number(index)] || '');
}

function latexToReadableMath(expr = '') {
  let value = String(expr || '').trim();
  const greek = {
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', theta: 'θ', lambda: 'λ', mu: 'μ',
    pi: 'π', sigma: 'σ', phi: 'φ', omega: 'ω', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ',
    Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Omega: 'Ω'
  };
  const supers = {
    '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
    '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', 'n': 'ⁿ', 'i': 'ⁱ'
  };
  const subs = {
    '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
    '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎', 'a': 'ₐ', 'e': 'ₑ', 'h': 'ₕ', 'i': 'ᵢ', 'j': 'ⱼ',
    'k': 'ₖ', 'l': 'ₗ', 'm': 'ₘ', 'n': 'ₙ', 'o': 'ₒ', 'p': 'ₚ', 'r': 'ᵣ', 's': 'ₛ', 't': 'ₜ', 'u': 'ᵤ',
    'v': 'ᵥ', 'x': 'ₓ'
  };

  const encodeScript = (input, table, fallbackPrefix) => {
    const raw = String(input || '').trim();
    if (!raw) return '';
    const converted = Array.from(raw).map((char) => table[char]).join('');
    if (converted && Array.from(raw).every((char) => table[char])) return converted;
    return `${fallbackPrefix}(${raw})`;
  };

  const replaceLoop = (pattern, replacer) => {
    let prev = '';
    while (prev !== value) {
      prev = value;
      value = value.replace(pattern, replacer);
    }
  };

  replaceLoop(/\\frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, (_, num, den) => `(${latexToReadableMath(num)}) ⁄ (${latexToReadableMath(den)})`);
  replaceLoop(/\\sqrt\s*\{([^{}]+)\}/g, (_, inner) => `√(${latexToReadableMath(inner)})`);
  value = value.replace(/\\operatorname\s*\{([^{}]+)\}/g, '$1');
  value = value.replace(/\\text\s*\{([^{}]+)\}/g, '$1');
  value = value.replace(/\\left|\\right/g, '');
  value = value.replace(/\\cdot/g, '·').replace(/\\times/g, '×').replace(/\\div/g, '÷');
  value = value.replace(/\\leq?/g, '≤').replace(/\\geq?/g, '≥').replace(/\\neq/g, '≠').replace(/\\approx/g, '≈');
  value = value.replace(/\\to/g, '→').replace(/\\infty/g, '∞').replace(/\\pm/g, '±');
  value = value.replace(/\\sum/g, 'Σ').replace(/\\prod/g, '∏').replace(/\\int/g, '∫');
  Object.entries(greek).forEach(([name, char]) => {
    value = value.replace(new RegExp(`\\\\${name}(?![A-Za-z])`, 'g'), char);
  });
  value = value.replace(/\^\{([^{}]+)\}/g, (_, inner) => encodeScript(latexToReadableMath(inner), supers, '^'));
  value = value.replace(/_\{([^{}]+)\}/g, (_, inner) => encodeScript(latexToReadableMath(inner), subs, '_'));
  value = value.replace(/\^([A-Za-z0-9+\-=()])/g, (_, inner) => encodeScript(inner, supers, '^'));
  value = value.replace(/_([A-Za-z0-9+\-=()])/g, (_, inner) => encodeScript(inner, subs, '_'));
  value = value.replace(/\\,/g, ' ').replace(/\\;/g, ' ');
  value = value.replace(/[{}]/g, '');
  value = value.replace(/\\/g, '');
  value = value.replace(/\s+/g, ' ').trim();
  return value;
}

function inlineMarkdown(text = '') {
  return renderMathAwareText(text);
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

function getFolderColorOptions() {
  return ['#2962ff', '#7c3aed', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#f97316', '#ec4899'];
}

function getFolderSuggestions() {
  const base = ['UCI Lectures', 'Product Weekly', 'Research Notes', 'Interview Prep', 'Team Sync', 'Personal Review'];
  return base.filter((name) => !state.folders.some((folder) => folder.name === name)).slice(0, 6);
}

function openCreateFolderModal() {
  state.folderDraft = {
    name: state.folderDraft.name || getFolderSuggestions()[0] || '',
    color: state.folderDraft.color || '#2962ff',
  };
  state.showFolderModal = true;
  scheduleRender();
}

function toggleSessionSelection(sessionId) {
  if (!sessionId) return;
  if (state.selectedSessionIds.includes(sessionId)) {
    state.selectedSessionIds = state.selectedSessionIds.filter((id) => id !== sessionId);
  } else {
    state.selectedSessionIds = [...state.selectedSessionIds, sessionId];
  }
}

function closeContextMenu() {
  state.sessionContextMenu = { visible: false, sessionId: '', x: 0, y: 0 };
}

function openMoveModal(sessionIds = []) {
  const uniqueIds = Array.from(new Set((sessionIds || []).filter(Boolean)));
  if (!uniqueIds.length) {
    showToast('Select at least one session first.', 'error');
    return;
  }
  state.moveSessionIds = uniqueIds;
  state.moveTargetFolderId = '';
  state.showMoveModal = true;
  scheduleRender();
}

async function confirmMoveModal() {
  if (!state.moveSessionIds.length) return;
  await moveSessionsToFolder(state.moveSessionIds, state.moveTargetFolderId || null);
  state.showMoveModal = false;
  state.selectionMode = false;
  state.selectedSessionIds = [];
  scheduleRender();
}

async function moveSessionsToFolder(sessionIds, folderId) {
  const ids = Array.from(new Set((sessionIds || []).filter(Boolean)));
  if (!ids.length) return;
  await Promise.all(ids.map((id) => api(`/api/sessions/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ folder_id: folderId || null }),
  })));
  if (state.currentSession && ids.includes(state.currentSession.id)) {
    state.currentSession.folder_id = folderId || null;
  }
  await refreshSidebarData();
  showToast(ids.length > 1 ? 'Sessions moved.' : 'Session moved.');
}

async function deleteSessions(sessionIds) {
  const ids = (sessionIds || []).filter(Boolean);
  if (!ids.length) {
    showToast('Select at least one session first.', 'error');
    return;
  }
  const confirmed = await askForConfirmation({
    title: ids.length > 1 ? 'Delete sessions' : 'Delete session',
    message: ids.length > 1 ? `Delete ${ids.length} selected sessions? This cannot be undone.` : 'Delete this session? This cannot be undone.',
    confirmLabel: 'Delete',
    cancelLabel: 'Cancel',
    tone: 'danger',
  });
  if (!confirmed) return;
  await Promise.all(ids.map((id) => api(`/api/sessions/${id}`, { method: 'DELETE' })));
  if (state.currentSession && ids.includes(state.currentSession.id)) {
    await leaveSession({ preserveView: false });
  }
  state.selectedSessionIds = state.selectedSessionIds.filter((id) => !ids.includes(id));
  await refreshSidebarData();
  closeContextMenu();
  scheduleRender();
  showToast(ids.length > 1 ? 'Selected sessions deleted.' : 'Session deleted.');
}

async function autoRenameSession(sessionId) {
  if (!sessionId) return;
  const result = await api(`/api/sessions/${sessionId}/auto-title`, { method: 'POST' });
  if (state.currentSession?.id === sessionId && result?.title) state.currentSession.title = result.title;
  await refreshSidebarData();
  scheduleRender();
  showToast('AI rename completed.');
}

function getDefaultNoteMethod(mode = 'lecture', methods = []) {
  if (methods?.length) return methods[0].id;
  return mode === 'meeting' ? 'meeting' : 'cornell';
}

function getNoteMethodLabel(id = '') {
  const match = (state.noteMethods || []).find((item) => item.id === id);
  return match?.name || id || 'default';
}

function createProgressState(label = 'Waiting') {
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
  progress.label = label || 'Done';
}

function failProgress(key, label) {
  const progress = state.progress[key];
  if (!progress) return;
  clearInterval(progress.timer);
  progress.timer = null;
  progress.active = false;
  progress.status = 'error';
  progress.label = label || 'Failed';
  progress.percent = Math.max(progress.percent || 0, 12);
}

function resetProgress(key, label = 'Waiting') {
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

function hasGeneratedContent(key) {
  if (key === 'notes') return Boolean(state.currentNote);
  if (key === 'action_items') return Boolean(state.currentNote && Object.prototype.hasOwnProperty.call(state.currentNote, 'action_items'));
  if (key === 'recaps') return Boolean((state.currentSummaries || []).some((summary) => summary.summary_type === 'concept'));
  if (key === 'qa') return Boolean((state.qaMessages || []).some((message) => message.role === 'assistant'));
  return false;
}

function syncDerivedProgressStates() {
  const defaults = {
    notes: 'Waiting to generate',
    action_items: 'Waiting to extract',
    recaps: 'Waiting to summarize',
    qa: 'Waiting for a question',
  };
  const labels = {
    notes: 'Notes already generated',
    action_items: 'Action items already extracted',
    recaps: 'Concept recaps available',
    qa: 'Answers already generated',
  };

  Object.keys(defaults).forEach((key) => {
    const progress = state.progress[key];
    if (!progress || progress.active) return;
    const exists = hasGeneratedContent(key);
    if (exists) {
      clearInterval(progress.timer);
      progress.timer = null;
      progress.active = false;
      progress.status = 'done';
      progress.percent = 100;
      progress.label = labels[key];
    } else if (progress.status === 'done') {
      progress.status = 'idle';
      progress.percent = 0;
      progress.label = defaults[key];
    }
  });
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
        <div class="progress-caption">Waiting for you to start it.</div>
      </div>
    `;
  }
  return `
    <div class="progress-panel ${progress.status === 'error' ? 'error' : progress.status === 'done' ? 'done' : ''}">
      <div class="progress-head">
        <div class="progress-title">${escapeHtml(title)}</div>
        <div class="progress-status ${escapeHtml(progress.status)}">${progress.status === 'running' ? 'Working' : progress.status === 'done' ? 'Complete' : progress.status === 'error' ? 'Error' : 'Ready'}</div>
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


function handleContextMenu(event) {
  const sessionEl = event.target.closest('[data-session-item="true"]');
  if (!sessionEl) {
    if (state.sessionContextMenu.visible) {
      closeContextMenu();
      scheduleRender();
    }
    return;
  }
  event.preventDefault();
  const sessionId = sessionEl.dataset.sessionId || '';
  state.sessionContextMenu = {
    visible: true,
    sessionId,
    x: Math.min(event.clientX, window.innerWidth - 220),
    y: Math.min(event.clientY, window.innerHeight - 180),
  };
  scheduleRender();
}

function handleDragStart(event) {
  const sessionEl = event.target.closest('[data-session-item="true"]');
  if (!sessionEl) return;
  const sessionId = sessionEl.dataset.sessionId || '';
  if (!sessionId) return;
  state.draggingSessionId = sessionId;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/session-id', sessionId);
  }
}

function handleDragEnd() {
  state.draggingSessionId = '';
  if (state.dragOverFolderId) {
    state.dragOverFolderId = '';
    scheduleRender();
  }
}

function handleDragOver(event) {
  const folderEl = event.target.closest('[data-folder-drop-target="true"]');
  if (!folderEl) return;
  event.preventDefault();
  const folderId = folderEl.dataset.folderId === '' ? '__root__' : (folderEl.dataset.folderId || '');
  if (state.dragOverFolderId !== folderId) {
    state.dragOverFolderId = folderId;
    scheduleRender();
  }
}

async function handleDrop(event) {
  const folderEl = event.target.closest('[data-folder-drop-target="true"]');
  if (!folderEl) return;
  event.preventDefault();
  const rawFolderId = folderEl.dataset.folderId || '';
  const sessionId = (event.dataTransfer && event.dataTransfer.getData('text/session-id')) || state.draggingSessionId;
  state.dragOverFolderId = '';
  state.draggingSessionId = '';
  if (!sessionId) return;
  await moveSessionsToFolder([sessionId], rawFolderId || null);
  scheduleRender();
}

function handleKeyDown(event) {
  if (event.key === 'Escape') {
    let changed = false;
    if (state.sessionContextMenu.visible) {
      closeContextMenu();
      changed = true;
    }
    if (state.showMoveModal) {
      state.showMoveModal = false;
      changed = true;
    }
    if (state.showFolderModal) {
      state.showFolderModal = false;
      changed = true;
    }
    if (state.showExportModal) {
      state.showExportModal = false;
      changed = true;
    }
    if (state.showSpeakerModal) {
      state.showSpeakerModal = false;
      changed = true;
    }
    if (state.showSettingsModal) {
      state.showSettingsModal = false;
      changed = true;
    }
    if (state.confirmDialog) {
      resolveConfirmation(false);
      return;
    }
    if (changed) scheduleRender();
  }
}

function autoResizeTitleField() {
  const field = app.querySelector('[data-model="session-title"]');
  if (!field) return;
  field.style.height = '0px';
  field.style.height = `${Math.max(40, field.scrollHeight)}px`;
}


function hydrateClientPreferences() {
  try {
    state.accounts = JSON.parse(localStorage.getItem(ACCOUNT_STORAGE_KEY) || '[]');
  } catch {
    state.accounts = [];
  }
  state.accounts = Array.isArray(state.accounts) ? state.accounts : [];

  try {
    state.authTokens = JSON.parse(sessionStorage.getItem(GOOGLE_TOKEN_STORAGE_KEY) || '{}');
  } catch {
    state.authTokens = {};
  }

  state.activeAccountId = localStorage.getItem(ACTIVE_ACCOUNT_STORAGE_KEY) || '';
  state.theme = localStorage.getItem(THEME_STORAGE_KEY) || 'light';

  if (state.activeAccountId && !state.accounts.some((account) => account.id === state.activeAccountId)) {
    state.activeAccountId = '';
  }
  if (!state.activeAccountId && state.accounts.length) {
    state.activeAccountId = state.accounts[0].id;
  }
}

function persistAccounts() {
  localStorage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify(state.accounts));
  localStorage.setItem(ACTIVE_ACCOUNT_STORAGE_KEY, state.activeAccountId || '');
}

function persistAuthTokens() {
  sessionStorage.setItem(GOOGLE_TOKEN_STORAGE_KEY, JSON.stringify(state.authTokens || {}));
}

function getActiveAccount() {
  return state.accounts.find((account) => account.id === state.activeAccountId) || null;
}

function getAccountDisplayName(account) {
  if (!account) return 'Guest';
  if (account.displayName) return account.displayName;
  const combined = `${account.firstName || ''} ${account.lastName || ''}`.trim();
  return combined || account.email || 'Untitled account';
}

function getAccountInitials(account) {
  if (!account) return 'JP';
  if (account.type === 'email') {
    const first = (account.firstName || account.displayName || account.email || 'U').trim();
    const last = (account.lastName || '').trim();
    const a = first.charAt(0) || 'U';
    const b = last ? last.slice(-1) : (first.charAt(1) || a);
    return `${a}${b}`.toUpperCase();
  }

  const words = getAccountDisplayName(account).split(/\s+/).filter(Boolean);
  if (words.length >= 2) return `${words[0][0] || ''}${words[1][0] || ''}`.toUpperCase();
  const first = words[0] || account.email || 'G';
  return first.slice(0, 2).toUpperCase();
}

function normalizeGoogleAvatarUrl(url = '') {
  let value = String(url || '').trim();
  if (!value) return '';
  if (/googleusercontent\.com/i.test(value)) {
    value = value.replace(/=s\d+(-c)?/i, '=s256-c');
  }
  return value;
}

function renderAccountAvatar(account) {
  const initials = getAccountInitials(account);
  if (account?.avatarUrl) {
    const src = normalizeGoogleAvatarUrl(account.avatarUrl);
    return `<div class="avatar avatar-photo-wrap"><span class="avatar-fallback">${escapeHtml(initials)}</span><img class="avatar-photo" src="${escapeAttr(src)}" alt="${escapeAttr(getAccountDisplayName(account))}" referrerpolicy="no-referrer" loading="eager" onerror="this.style.display='none'; this.closest('.avatar-photo-wrap')?.classList.add('image-failed');" /></div>`;
  }
  return `<div class="avatar">${escapeHtml(initials)}</div>`;
}

function upsertAccount(account) {
  const existingIndex = state.accounts.findIndex((item) => item.id === account.id);
  if (existingIndex >= 0) state.accounts.splice(existingIndex, 1, { ...state.accounts[existingIndex], ...account });
  else state.accounts = [account, ...state.accounts];
  state.activeAccountId = account.id;
  persistAccounts();
}

function switchActiveAccount(accountId) {
  if (!accountId || !state.accounts.some((account) => account.id === accountId)) return;
  state.activeAccountId = accountId;
  persistAccounts();
  if (state.exportDestination === 'drive' && !canUseDriveExport()) {
    state.exportDestination = 'download';
  }
  scheduleRender();
  const account = getActiveAccount();
  showToast(`${getAccountDisplayName(account)} is now the active account.`);
}

async function removeAccount(accountId) {
  if (!accountId) return;
  const account = state.accounts.find((item) => item.id === accountId);
  if (!account) return;
  const confirmed = await askForConfirmation({
    title: 'Remove account',
    message: `Remove ${getAccountDisplayName(account)} from this device?`,
    confirmLabel: 'Remove',
    cancelLabel: 'Keep',
    tone: 'danger',
  });
  if (!confirmed) return;

  if (account.type === 'google') {
    const token = state.authTokens?.[account.id]?.accessToken;
    if (token && window.google?.accounts?.oauth2?.revoke) {
      try {
        window.google.accounts.oauth2.revoke(token, () => {});
      } catch {}
    }
    if (state.authTokens?.[account.id]) {
      delete state.authTokens[account.id];
      persistAuthTokens();
    }
  }

  state.accounts = state.accounts.filter((item) => item.id !== accountId);
  if (state.activeAccountId === accountId) {
    state.activeAccountId = state.accounts[0]?.id || '';
  }
  if (state.exportDestination === 'drive' && !canUseDriveExport()) {
    state.exportDestination = 'download';
  }
  persistAccounts();
  scheduleRender();
  showToast('Account removed.');
}

function setTheme(theme) {
  state.theme = theme === 'dark' ? 'dark' : 'light';
  localStorage.setItem(THEME_STORAGE_KEY, state.theme);
  applyTheme();
  scheduleRender();
}

function applyTheme() {
  document.documentElement.dataset.theme = state.theme === 'dark' ? 'dark' : 'light';
  document.documentElement.style.colorScheme = state.theme === 'dark' ? 'dark' : 'light';
}

function canUseDriveExport() {
  const account = getActiveAccount();
  return Boolean(account && account.type === 'google');
}

function getDriveExportDescription() {
  const account = getActiveAccount();
  if (account?.type === 'google') return `Upload directly to ${getAccountDisplayName(account)}'s Google Drive`;
  return 'Switch to a Google sign-in first';
}

function isValidEmail(email = '') {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim());
}

async function addEmailAccount() {
  const firstName = String(state.emailAccountDraft.firstName || '').trim();
  const lastName = String(state.emailAccountDraft.lastName || '').trim();
  const email = String(state.emailAccountDraft.email || '').trim().toLowerCase();

  if (!firstName || !lastName || !email) {
    showToast('Please fill in first name, last name, and email.', 'error');
    return;
  }
  if (!isValidEmail(email)) {
    showToast('The email format is invalid.', 'error');
    return;
  }

  const id = `email:${email}`;
  upsertAccount({
    id,
    type: 'email',
    firstName,
    lastName,
    displayName: `${firstName} ${lastName}`.trim(),
    email,
    avatarUrl: '',
    createdAt: new Date().toISOString(),
  });

  state.emailAccountDraft = { firstName: '', lastName: '', email: '' };
  scheduleRender();
  showToast('Email account added and set as active.');
}

function getGoogleClientId() {
  const clientId = state.aiSettings ? state.aiSettings.googleDriveClientId : window.SCRIBE_CONFIG?.googleDriveClientId;
  if (!clientId) throw new Error('Missing Google OAuth client ID configuration.');
  return clientId;
}

async function requestGoogleAccessToken({ prompt = 'select_account consent', loginHint = '' } = {}) {
  if (!window.google?.accounts?.oauth2) {
    throw new Error('Google sign-in is still loading or blocked by the browser. Wait a moment and click again; allow accounts.google.com if using a blocker.');
  }

  const clientId = getGoogleClientId();
  return await new Promise((resolve, reject) => {
    const tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: GOOGLE_AUTH_SCOPE,
      prompt,
      login_hint: loginHint || undefined,
      include_granted_scopes: true,
      callback: (resp) => {
        if (!resp || resp.error) {
          reject(new Error(resp?.error_description || resp?.error || 'Google authorization failed.'));
          return;
        }
        resolve(resp);
      },
      error_callback: (err) => {
        reject(new Error(err?.type === 'popup_failed_to_open' ? 'Google popup was blocked. Allow popups for this Noted page, then click again.' : err?.type === 'popup_closed' ? 'Google sign-in was closed. Click Continue with Google to try again.' : (err?.type || 'Google sign-in did not complete.')));
      },
    });
    tokenClient.requestAccessToken({ prompt, login_hint: loginHint || undefined });
  });
}

async function fetchGoogleUserProfile(accessToken) {
  const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error('Failed to load Google user information.');
  }
  return response.json();
}

async function addGoogleAccount() {
  state.authBusy = true;
  scheduleRender();
  try {
    const tokenResponse = await requestGoogleAccessToken({ prompt: 'select_account consent' });
    if (!tokenResponse.scope?.includes('https://www.googleapis.com/auth/drive.file')) throw new Error('Google Drive permission was not granted. Please reconnect and allow Drive export.');
    const profile = await fetchGoogleUserProfile(tokenResponse.access_token);
    const account = {
      id: `google:${profile.sub}`,
      type: 'google',
      firstName: profile.given_name || '',
      lastName: profile.family_name || '',
      displayName: profile.name || [profile.given_name, profile.family_name].filter(Boolean).join(' ') || profile.email || 'Google user',
      email: profile.email || '',
      avatarUrl: normalizeGoogleAvatarUrl(profile.picture || ''),
      sub: profile.sub,
      createdAt: new Date().toISOString(),
    };
    upsertAccount(account);
    state.authTokens[account.id] = {
      accessToken: tokenResponse.access_token,
      expiresAt: Date.now() + Math.max(0, Number(tokenResponse.expires_in || 0) * 1000),
      scope: tokenResponse.scope || GOOGLE_AUTH_SCOPE,
    };
    persistAuthTokens();
    scheduleRender();
    showToast(`Google account ${account.displayName} connected.`);
  } finally {
    state.authBusy = false;
    scheduleRender();
  }
}

async function ensureGoogleDriveAccessToken(account) {
  if (!account || account.type !== 'google') {
    throw new Error('The active account is not a Google account.');
  }

  const existing = state.authTokens?.[account.id];
  if (existing?.accessToken && existing.scope?.includes('https://www.googleapis.com/auth/drive.file') && Number(existing.expiresAt || 0) > Date.now() + 60_000) {
    return existing.accessToken;
  }

  const tokenResponse = await requestGoogleAccessToken({
    prompt: '',
    loginHint: account.email || account.sub || '',
  });

  const profile = await fetchGoogleUserProfile(tokenResponse.access_token);
  if (profile.sub !== account.sub) throw new Error('A different Google account was selected. Switch accounts in Settings before exporting.');
  if (!tokenResponse.scope?.includes('https://www.googleapis.com/auth/drive.file')) throw new Error('Google Drive permission was not granted. Reconnect using Continue with Google.');

  state.authTokens[account.id] = {
    accessToken: tokenResponse.access_token,
    expiresAt: Date.now() + Math.max(0, Number(tokenResponse.expires_in || 0) * 1000),
    scope: tokenResponse.scope || GOOGLE_AUTH_SCOPE,
  };
  persistAuthTokens();
  return tokenResponse.access_token;
}

function askForConfirmation({
  title = 'Confirm action',
  message = 'Are you sure you want to continue?',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'danger',
} = {}) {
  if (pendingConfirmResolver) {
    pendingConfirmResolver(false);
    pendingConfirmResolver = null;
  }
  state.confirmDialog = { title, message, confirmLabel, cancelLabel, tone };
  scheduleRender();
  return new Promise((resolve) => {
    pendingConfirmResolver = resolve;
  });
}

function resolveConfirmation(result) {
  const resolve = pendingConfirmResolver;
  pendingConfirmResolver = null;
  state.confirmDialog = null;
  scheduleRender();
  if (resolve) resolve(Boolean(result));
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
