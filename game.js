// ── OBFUSCATED ATTACK · DEMO — public frontend ─────────────────────────
// Public build differences from app/static/demo/demo.js:
//   • all API calls go to BACKEND_URL (the ngrok tunnel for the GPU host)
//   • every request carries a Basic-auth header with the demo password
//   • image <img src=...> URLs use ?p=<password> query (img tags can't
//     send custom headers); the backend accepts either form

// Auto-detect deployment: on github.io, route every fetch through the ngrok
// tunnel that fronts the backend on privsec0:8764. On any other host
// (local http://127.0.0.1:8764/ui/), stay same-origin.
const BACKEND_URL = (typeof location !== "undefined" && location.hostname === "baroian.github.io")
  ? "https://thirstily-grieving-evidence.ngrok-free.dev"
  : "";
const AUTH_KEY = "deobfuscating.demoAuth";

function getAuthPassword() {
  try { return sessionStorage.getItem(AUTH_KEY) || ""; } catch (e) { return ""; }
}
function setAuthPassword(pw) {
  try { sessionStorage.setItem(AUTH_KEY, pw); } catch (e) { /* private mode */ }
}
function clearAuthPassword() {
  try { sessionStorage.removeItem(AUTH_KEY); } catch (e) {}
}

function authedFetch(path, options = {}) {
  const url = path.startsWith("http") ? path : BACKEND_URL + path;
  const headers = new Headers(options.headers || {});
  const pw = getAuthPassword();
  if (pw && !headers.has("Authorization")) {
    headers.set("Authorization", "Basic " + btoa(":" + pw));
  }
  // When cross-origin via the ngrok tunnel, bypass ngrok-free's HTML
  // interstitial for fetch requests. Same-origin (local /ui/) doesn't need it
  // but the backend CORS allow-list explicitly whitelists the header so it's
  // safe to send unconditionally.
  if (BACKEND_URL) {
    headers.set("ngrok-skip-browser-warning", "1");
  }
  return fetch(url, { ...options, headers });
}

function buildImageUrl(name) {
  // Level PNGs are bundled with the GitHub Pages deploy (same-origin) so the
  // <img> tag and clipboard fetch never go through ngrok — that path was
  // unreliable: ngrok's free-tier interstitial forced a CORS preflight on
  // every fetch, and parallel preflights for the level grid sporadically
  // dropped the follow-up GET ("Failed to fetch").
  return `./images/${encodeURIComponent(name)}`;
}

function newSessionId() {
  if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "s-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const state = {
  sessionId: newSessionId(),
  model: null,
  systemPrompt: null,
  defaultSystemPrompt: null,
  busy: false,
  abortController: null,
  assistantBubbleEl: null,
  pendingImage: null, // { file, previewUrl }
  levels: null,
};

const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const ACCEPTED_MIME = ["image/png", "image/jpeg", "image/webp"];

const els = {
  messages: document.getElementById("messages"),
  input: document.getElementById("user-input"),
  btnSend: document.getElementById("btn-send"),
  btnStop: document.getElementById("btn-stop"),
  btnNewChat: document.getElementById("btn-new-chat"),
  btnEditPrompt: document.getElementById("btn-edit-prompt"),
  btnInspect: document.getElementById("btn-inspect"),
  btnAttach: document.getElementById("btn-attach"),
  btnRemoveAttachment: document.getElementById("btn-remove-attachment"),
  fileInput: document.getElementById("file-input"),
  attachmentPreview: document.getElementById("attachment-preview"),
  attachmentThumb: document.getElementById("attachment-thumb"),
  attachmentName: document.getElementById("attachment-name"),
  attachmentSize: document.getElementById("attachment-size"),
  modelPin: document.getElementById("model-pin-name"),
  composeHint: document.getElementById("compose-hint"),
  inspector: document.getElementById("inspector"),
  inspectorBody: document.getElementById("inspector-body"),
  btnCloseInspector: document.getElementById("btn-close-inspector"),
  btnCopyTranscript: document.getElementById("btn-copy-transcript"),
  promptDialog: document.getElementById("prompt-dialog"),
  promptTextarea: document.getElementById("prompt-textarea"),
  btnSavePrompt: document.getElementById("btn-save-prompt"),
  btnLevels: document.getElementById("btn-levels"),
  levelsDialog: document.getElementById("levels-dialog"),
  levelsGrid: document.getElementById("levels-grid"),
  levelsIntro: document.getElementById("levels-intro"),
  btnCloseLevels: document.getElementById("btn-close-levels"),
  btnTheme: document.getElementById("btn-theme"),
  btnIntro: document.getElementById("btn-intro"),
  introDialog: document.getElementById("intro-dialog"),
  btnCloseIntro: document.getElementById("btn-close-intro"),
  btnStart: document.getElementById("btn-start"),
};

// ── Theme toggle ─────────────────────────────────────────────────────
// Pre-paint theme is set by an inline <script> in index.html so the right
// vars bind before first paint. Here we just read the current state and
// flip it on click. localStorage key: "deobfuscating.demo.theme" → "dark"|"light".
const THEME_KEY = "deobfuscating.demo.theme";
function currentTheme() {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}
function refreshThemeButton() {
  if (!els.btnTheme) return;
  // Label shows the *target* of the action — clicking flips to that mode.
  els.btnTheme.textContent = currentTheme() === "dark" ? "☀ LIGHT" : "◑ DARK";
}
function setTheme(mode) {
  const next = mode === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* private mode etc. */ }
  refreshThemeButton();
}
function toggleTheme() {
  setTheme(currentTheme() === "dark" ? "light" : "dark");
}

// ── Helpers ──────────────────────────────────────────────────────────
function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "onclick") e.onclick = v;
    else if (k === "hidden") { if (v) e.hidden = true; }
    else e.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return e;
}

function scrollToBottom() {
  requestAnimationFrame(() => { els.messages.scrollTop = els.messages.scrollHeight; });
}

// `destructive_capable` is a tool-class capability (every bash call carries it),
// not a runtime fact — `ls -la` shouldn't paint red. We reserve the red ⚠
// DESTRUCTIVE styling for the runtime flags actually emitted by the handler:
// `destructive_command_attempted` (matched against shell.py's regex set) and
// `python_exec_attempted` (every run_python). The capability is implicit in
// the tool name "bash", so we don't render a separate badge for it either.
function renderBadges(flags = []) {
  const out = [];
  if (flags.includes("exfil")) out.push(el("span", { class: "badge badge--exfil" }, "⚠ EXFIL"));
  if (flags.includes("destructive_command_attempted") || flags.includes("python_exec_attempted"))
    out.push(el("span", { class: "badge badge--destructive" }, "⚠ DESTRUCTIVE"));
  if (flags.includes("untrusted")) out.push(el("span", { class: "badge badge--untrusted" }, "untrusted-data"));
  return out;
}

function flagClass(flags = []) {
  if (flags.includes("exfil")) return "tool-card--exfil";
  if (flags.includes("destructive_command_attempted") || flags.includes("python_exec_attempted"))
    return "tool-card--destructive";
  if (flags.includes("untrusted")) return "tool-card--untrusted";
  return "";
}

function makeToolCard(kind, toolName, flags, bodyText, meta = "") {
  const cls = flagClass(flags);
  const card = el("div", { class: `tool-card ${cls} collapsed` });
  const head = el("div", { class: "head" },
    el("div", { class: "title" },
      el("span", { class: "kind" }, kind),
      el("span", { class: "name" }, toolName),
      ...renderBadges(flags),
    ),
    el("div", { class: "meta" }, meta, el("span", { class: "caret" }, "▾")),
  );
  const body = el("div", { class: "body" }, bodyText);
  head.onclick = () => card.classList.toggle("collapsed");
  card.appendChild(head);
  card.appendChild(body);
  return { card, bodyEl: body, headMetaEl: head.querySelector(".meta") };
}

function closeAssistantBubble() { state.assistantBubbleEl = null; }

function ensureAssistantBubble() {
  if (state.assistantBubbleEl) return state.assistantBubbleEl;
  removeEmptyState();
  const msg = el("div", { class: "msg assistant" },
    el("div", { class: "avatar" }, "Z"),
    el("div", { class: "bubble" }),
  );
  els.messages.appendChild(msg);
  state.assistantBubbleEl = msg.querySelector(".bubble");
  scrollToBottom();
  return state.assistantBubbleEl;
}

function appendUserMessage(text, imagePreviewUrl, imageCaption) {
  const bubbleChildren = [];
  if (imagePreviewUrl) {
    const img = el("img", { class: "inline-image", src: imagePreviewUrl, alt: imageCaption || "attached image" });
    img.addEventListener("click", () => window.open(imagePreviewUrl, "_blank"));
    bubbleChildren.push(img);
    if (imageCaption) bubbleChildren.push(el("div", { class: "inline-image-caption" }, imageCaption));
  }
  if (text) bubbleChildren.push(document.createTextNode(text));
  removeEmptyState();
  const msg = el("div", { class: "msg user" },
    el("div", { class: "avatar" }, "U"),
    el("div", { class: "bubble" }, ...bubbleChildren),
  );
  els.messages.appendChild(msg);
  scrollToBottom();
}

function appendError(msg) {
  removeEmptyState();
  const b = el("div", { class: "error-banner" }, `✖ ${msg}`);
  els.messages.appendChild(b);
  scrollToBottom();
}

function renderEmptyState() {
  if (!els.messages) return;
  if (els.messages.querySelector(".empty-state")) return;
  if (els.messages.children.length > 0) return;
  const hero = el("div", { class: "empty-state" },
    el("div", { class: "empty-sub" }, "Open IMAGES · copy a tile · paste it here"),
  );
  els.messages.appendChild(hero);
}

function removeEmptyState() {
  const e = els.messages && els.messages.querySelector(".empty-state");
  if (e) e.remove();
}

// ── Attachment helpers ───────────────────────────────────────────────
function humanSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function setPendingImage(file) {
  clearPendingImage();
  if (!file) return;
  if (!ACCEPTED_MIME.includes(file.type) && !/\.(png|jpe?g|webp)$/i.test(file.name)) {
    appendError(`unsupported file type: ${file.type || file.name}`);
    return;
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    appendError(`image too large: ${humanSize(file.size)} (max ${humanSize(MAX_UPLOAD_BYTES)})`);
    return;
  }
  const previewUrl = URL.createObjectURL(file);
  state.pendingImage = { file, previewUrl };
  els.attachmentThumb.src = previewUrl;
  els.attachmentName.textContent = file.name;
  els.attachmentSize.textContent = humanSize(file.size);
  els.attachmentPreview.hidden = false;
}

function clearPendingImage() {
  if (state.pendingImage?.previewUrl) URL.revokeObjectURL(state.pendingImage.previewUrl);
  state.pendingImage = null;
  els.attachmentPreview.hidden = true;
  els.attachmentThumb.removeAttribute("src");
  els.attachmentName.textContent = "";
  els.attachmentSize.textContent = "";
  if (els.fileInput) els.fileInput.value = "";
}

// ── Streaming chat ───────────────────────────────────────────────────
async function streamChat(userMessage, imageFile) {
  state.busy = true;
  els.btnSend.disabled = true;
  els.btnStop.hidden = false;
  els.composeHint.textContent = imageFile ? "UPLOADING…" : "STREAMING…";

  state.abortController = new AbortController();
  const pendingCalls = new Map();

  try {
    if (!state.sessionId) state.sessionId = newSessionId();

    const fd = new FormData();
    fd.append("session_id", state.sessionId);
    fd.append("message", userMessage);
    if (state.model) fd.append("model", state.model);
    if (state.systemPrompt != null) fd.append("system_prompt", state.systemPrompt);
    if (imageFile) fd.append("image", imageFile, imageFile.name);

    const resp = await authedFetch("/api/chat", {
      method: "POST",
      signal: state.abortController.signal,
      body: fd,
    });

    if (resp.ok) {
      els.composeHint.textContent = "STREAMING…";
    }

    if (!resp.ok) {
      const errText = await resp.text();
      appendError(`HTTP ${resp.status}: ${errText.slice(0, 400)}`);
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    outer:
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const ev = parseSseFrame(frame);
        if (!ev) continue;
        const handled = handleEvent(ev, pendingCalls);
        if (handled === "terminate") break outer;
      }
    }
  } catch (e) {
    if (e.name === "AbortError") appendError("stopped by user");
    else appendError(`client error: ${e.message || e}`);
  } finally {
    state.busy = false;
    state.abortController = null;
    els.btnSend.disabled = false;
    els.btnStop.hidden = true;
    els.composeHint.textContent = "READY";
    closeAssistantBubble();
  }
}

function parseSseFrame(frame) {
  let event = "message";
  let data = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!data) return null;
  try { return { event, data: JSON.parse(data) }; }
  catch { return { event, data: { raw: data } }; }
}

function handleEvent(ev, pendingCalls) {
  switch (ev.event) {
    case "session": {
      const sid = ev.data.session_id;
      if (sid && sid !== state.sessionId) state.sessionId = sid;
      return;
    }
    case "token": {
      const bubble = ensureAssistantBubble();
      bubble.textContent += ev.data.delta || "";
      scrollToBottom();
      return;
    }
    case "reasoning": {
      let reasoningEl = state._reasoningEl;
      if (!reasoningEl) {
        reasoningEl = el("div", { class: "tool-card collapsed" });
        const head = el("div", { class: "head" },
          el("div", { class: "title" },
            el("span", { class: "kind" }, "reasoning"),
            el("span", { class: "name" }, "(thinking)"),
          ),
          el("div", { class: "meta" }, el("span", { class: "caret" }, "▾")),
        );
        head.onclick = () => reasoningEl.classList.toggle("collapsed");
        const body = el("div", { class: "body muted" });
        reasoningEl.appendChild(head);
        reasoningEl.appendChild(body);
        els.messages.appendChild(reasoningEl);
        state._reasoningEl = reasoningEl;
        state._reasoningBody = body;
      }
      state._reasoningBody.textContent += ev.data.delta || "";
      return;
    }
    case "tool_call": {
      closeAssistantBubble();
      const { id, name, arguments: args, flags, step } = ev.data;
      const body = JSON.stringify(args, null, 2);
      const { card, headMetaEl } = makeToolCard("call", name, flags, body, `step ${step}`);
      els.messages.appendChild(card);
      pendingCalls.set(id, { card, headMetaEl });
      // Auto-expand only on actually-suspect calls — capability alone (every
      // bash call) shouldn't pop them open.
      if ((flags || []).some(f => ["exfil","destructive_command_attempted","python_exec_attempted"].includes(f))) {
        card.classList.remove("collapsed");
      }
      scrollToBottom();
      return;
    }
    case "tool_result": {
      const { id, name, response, flags, elapsed_ms } = ev.data;
      const meta = `${elapsed_ms}ms`;
      const { card } = makeToolCard("result", name, flags, response || "(empty)", meta);
      els.messages.appendChild(card);
      if ((flags || []).some(f => ["exfil","destructive_command_attempted","python_exec_attempted"].includes(f))) {
        card.classList.remove("collapsed");
      }
      scrollToBottom();
      return;
    }
    case "assistant_end": {
      closeAssistantBubble();
      state._reasoningEl = null;
      state._reasoningBody = null;
      return;
    }
    case "error": {
      appendError(ev.data.message || "unknown error");
      return;
    }
    case "done": { return "terminate"; }
  }
}

// ── Levels modal ─────────────────────────────────────────────────────
async function loadLevels() {
  const r = await authedFetch("/api/demo/levels");
  if (!r.ok) throw new Error(`levels HTTP ${r.status}`);
  return await r.json();
}

function renderLevels(levelsData) {
  els.levelsGrid.innerHTML = "";
  if (levelsData.intro && els.levelsIntro) els.levelsIntro.textContent = levelsData.intro;

  for (const lv of levelsData.levels) {
    const imgUrl = buildImageUrl(lv.image);
    const card = el("div", { class: "level-card" });

    // Images are served same-origin from GitHub Pages, so <img src> works
    // directly. Click handlers fetch() the same URL on demand to materialise
    // a Blob for clipboard.write / setPendingImage.
    const imgEl = el("img", { src: imgUrl, alt: lv.name, draggable: "true" });
    const frame = el("div", { class: "level-image-frame" }, imgEl);
    card.appendChild(frame);

    const metaChildren = [el("div", { class: "level-name" }, lv.name)];
    if (lv.tagline) metaChildren.push(el("div", { class: "level-tagline" }, lv.tagline));
    card.appendChild(el("div", { class: "level-meta" }, ...metaChildren));
    if (lv.body) card.appendChild(el("div", { class: "level-body" }, lv.body));

    const copyBtn = el("button", { class: "btn primary small" }, "▸ COPY IMAGE");
    const useBtn = el("button", { class: "btn ghost small" }, "USE NOW");

    async function fetchLevelBlob() {
      const r = await fetch(imgUrl);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.blob();
    }

    copyBtn.addEventListener("click", async () => {
      let blob = null;
      try {
        blob = await fetchLevelBlob();
        const type = blob.type || "image/png";
        if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
          // Old browser. Fall through to USE-NOW behaviour transparently.
          throw new Error("CLIPBOARD_UNSUPPORTED");
        }
        await navigator.clipboard.write([new ClipboardItem({ [type]: blob })]);
        copyBtn.classList.add("copy-ok");
        copyBtn.textContent = "✓ COPIED";
        setTimeout(() => {
          copyBtn.classList.remove("copy-ok");
          copyBtn.textContent = "▸ COPY IMAGE";
        }, 1400);
      } catch (e) {
        if (e && e.message === "CLIPBOARD_UNSUPPORTED" && blob) {
          // Old browser — silently fall back to staging the image directly.
          const file = new File([blob], lv.image, { type: blob.type || "image/png" });
          setPendingImage(file);
          els.levelsDialog.close();
          requestAnimationFrame(() => els.input.focus());
        } else {
          // Real failure (e.g. NotAllowedError in non-secure context). Surface
          // it; let the user click USE NOW instead of silently auto-staging.
          copyBtn.textContent = "✖ FAILED — TRY USE NOW";
          copyBtn.title = String(e);
          setTimeout(() => { copyBtn.textContent = "▸ COPY IMAGE"; }, 1800);
        }
      }
    });

    useBtn.addEventListener("click", async () => {
      // Stage the level image directly into the composer attachment slot.
      try {
        const blob = await fetchLevelBlob();
        const file = new File([blob], lv.image, { type: blob.type || "image/png" });
        setPendingImage(file);
        els.levelsDialog.close();
        // rAF defers focus past the dialog's own focus-restore microtask.
        requestAnimationFrame(() => els.input.focus());
      } catch (e) {
        appendError(`could not load level image: ${e.message || e}`);
      }
    });

    card.appendChild(el("div", { class: "level-actions" }, copyBtn, useBtn));

    els.levelsGrid.appendChild(card);
  }
}

function appendInfoBlock(parent, text, kind) {
  parent.appendChild(el("div", { class: `level-hint-block level-hint-${kind}` }, text));
}

async function openLevels() {
  // showModal() throws InvalidStateError if [open] is already set — guard
  // covers double-clicks and the L-hotkey firing while the dialog is up.
  if (els.levelsDialog.open) return;
  if (!state.levels) {
    try {
      state.levels = await loadLevels();
    } catch (e) {
      appendError(`could not load levels: ${e.message || e}`);
      return;
    }
  }
  renderLevels(state.levels);
  els.levelsDialog.showModal();
}

// ── Wiring ───────────────────────────────────────────────────────────
async function init() {
  // Pull config to discover the locally-served model id (set by serve.py via
  // LLM_DEFAULT_MODEL → /api/config.default_model). No model selector in this
  // page — pinned to whatever the server says is default.
  let configResp;
  try {
    configResp = await authedFetch("/api/config").then(r => r.json());
  } catch (e) {
    // Fall through with nulls so the server picks its own defaults — sending
    // a hardcoded model id risks routing to OpenRouter if config.yaml uses a
    // different default-id casing than what we'd guess.
    configResp = { default_model: null, system_prompt: null };
    appendError(`could not load /api/config: ${e.message || e}`);
  }

  state.model = configResp.default_model;
  state.defaultSystemPrompt = configResp.system_prompt;
  state.systemPrompt = state.defaultSystemPrompt;

  if (els.modelPin) els.modelPin.textContent = state.model || "—";

  // Send / stop / textarea behaviour
  els.btnSend.addEventListener("click", onSend);
  els.btnStop.addEventListener("click", () => state.abortController?.abort());
  els.input.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); onSend(); }
  });
  const autoGrow = () => {
    els.input.style.height = "auto";
    els.input.style.height = Math.min(els.input.scrollHeight, 260) + "px";
  };
  els.input.addEventListener("input", autoGrow);
  autoGrow();

  // Attach / paste / drop image — same handlers as main page.
  els.btnAttach.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", () => {
    const f = els.fileInput.files && els.fileInput.files[0];
    if (f) setPendingImage(f);
  });
  els.btnRemoveAttachment.addEventListener("click", (e) => {
    e.preventDefault();
    clearPendingImage();
  });

  const dropBox = document.querySelector(".composer-box");
  dropBox.addEventListener("dragover", (e) => { e.preventDefault(); dropBox.classList.add("drop-target"); });
  dropBox.addEventListener("dragleave", () => dropBox.classList.remove("drop-target"));
  dropBox.addEventListener("drop", (e) => {
    e.preventDefault();
    dropBox.classList.remove("drop-target");
    const f = e.dataTransfer?.files && e.dataTransfer.files[0];
    if (f) setPendingImage(f);
  });

  els.input.addEventListener("paste", (e) => {
    const items = e.clipboardData?.items || [];
    for (const it of items) {
      if (it.kind === "file") {
        const f = it.getAsFile();
        if (f && ACCEPTED_MIME.includes(f.type)) {
          e.preventDefault();
          setPendingImage(f);
          return;
        }
      }
    }
  });

  // New chat
  els.btnNewChat.addEventListener("click", () => {
    // Kill any in-flight stream BEFORE clearing — otherwise late `token`
    // events keep arriving and re-spawn an assistant bubble in the new chat.
    state.abortController?.abort();
    state.sessionId = newSessionId();
    els.messages.innerHTML = "";
    state.assistantBubbleEl = null;
    state._reasoningEl = null;
    state._reasoningBody = null;
    clearPendingImage();
    renderEmptyState();
  });

  // Theme toggle (initial label reflects the pre-paint state set in <head>)
  refreshThemeButton();
  els.btnTheme.addEventListener("click", toggleTheme);

  // Inspector
  els.btnInspect.addEventListener("click", toggleInspector);
  els.btnCloseInspector.addEventListener("click", () => els.inspector.hidden = true);
  els.btnCopyTranscript.addEventListener("click", () => {
    navigator.clipboard.writeText(els.inspectorBody.textContent);
    els.btnCopyTranscript.textContent = "copied!";
    setTimeout(() => els.btnCopyTranscript.textContent = "copy", 1200);
  });
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "i") {
      e.preventDefault();
      toggleInspector();
    }
  });

  // Prompt editor
  els.btnEditPrompt.addEventListener("click", () => {
    els.promptTextarea.value = state.systemPrompt || "";
    els.promptDialog.showModal();
  });
  els.promptDialog.addEventListener("close", () => {
    if (els.promptDialog.returnValue === "save") state.systemPrompt = els.promptTextarea.value;
  });

  // Levels dialog
  els.btnLevels.addEventListener("click", openLevels);
  els.btnCloseLevels.addEventListener("click", () => els.levelsDialog.close());
  // Click on the backdrop (outside the dialog content) closes it. The native
  // <dialog> element fires click on itself when the dark area is clicked;
  // any click on a child bubbles up but with target=child, so the equality
  // check distinguishes backdrop vs content.
  els.levelsDialog.addEventListener("click", (e) => {
    if (e.target === els.levelsDialog) els.levelsDialog.close();
  });
  // "L" hotkey opens levels (when textarea isn't focused)
  document.addEventListener("keydown", (e) => {
    const target = e.target;
    const inField = target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT");
    if (!inField && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "l") {
      e.preventDefault();
      openLevels();
    }
  });

  // Intro dialog — auto-opens after auth on every page load. Reopenable from
  // the topbar INTRO button. Backdrop click closes; START button confirms.
  function openIntro() {
    if (els.introDialog && !els.introDialog.open) els.introDialog.showModal();
  }
  function closeIntro() {
    if (els.introDialog && els.introDialog.open) els.introDialog.close();
  }
  if (els.btnIntro) els.btnIntro.addEventListener("click", openIntro);
  if (els.btnCloseIntro) els.btnCloseIntro.addEventListener("click", closeIntro);
  if (els.btnStart) els.btnStart.addEventListener("click", closeIntro);
  if (els.introDialog) {
    els.introDialog.addEventListener("click", (e) => {
      if (e.target === els.introDialog) els.introDialog.close();
    });
  }

  renderEmptyState();
  openIntro();
}

function onSend() {
  const text = els.input.value.trim();
  const pending = state.pendingImage;
  if (!text && !pending) return;
  if (state.busy) return;
  els.input.value = "";

  let imageFile = null;
  let inlinePreviewUrl = null;
  let inlineCaption = null;
  if (pending) {
    imageFile = pending.file;
    inlinePreviewUrl = URL.createObjectURL(pending.file);
    inlineCaption = `${pending.file.name} (${humanSize(pending.file.size)})`;
  }
  appendUserMessage(text, inlinePreviewUrl, inlineCaption);
  clearPendingImage();
  streamChat(text, imageFile);
}

async function toggleInspector() {
  if (!els.inspector.hidden) { els.inspector.hidden = true; return; }
  els.inspector.hidden = false;
  try {
    const r = await authedFetch(`/api/session/${state.sessionId}/transcript`);
    if (r.ok) {
      const { messages } = await r.json();
      els.inspectorBody.textContent = JSON.stringify(messages, null, 2);
    } else {
      els.inspectorBody.textContent = "(no session yet — send a message first)";
    }
  } catch (e) {
    els.inspectorBody.textContent = `error: ${e.message || e}`;
  }
}

// ── Auth gate bootstrap ──────────────────────────────────────────────
// On load, try the cached sessionStorage password against /api/config. If it
// works, hide the gate and run init(). Otherwise show the gate, and on submit
// try the entered password the same way.
async function bootstrap() {
  const gate = document.getElementById("auth-gate");
  const form = document.getElementById("auth-form");
  const input = document.getElementById("auth-password");
  const errorEl = document.getElementById("auth-error");

  async function tryPassword(pw) {
    setAuthPassword(pw);
    try {
      const r = await authedFetch("/api/config");
      if (r.ok) return true;
      if (r.status === 401) return false;
      throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      throw e;
    }
  }

  // LOCAL-ONLY: the local proxy runs with DEMO_AUTH off, so /api/config
  // returns 200 regardless of password. Probe with an empty password first;
  // if the backend accepts it, skip the gate entirely for a frictionless
  // local demo. (On an auth-enabled backend this 401s and we fall through.)
  try {
    if (await tryPassword("")) {
      gate.hidden = true;
      return init();
    }
  } catch (e) { /* fall through to gate */ }

  // Try cached password next.
  const cached = getAuthPassword();
  if (cached) {
    try {
      if (await tryPassword(cached)) {
        gate.hidden = true;
        return init();
      }
    } catch (e) { /* fall through to gate */ }
    clearAuthPassword();
  }

  // Show gate.
  gate.hidden = false;
  input.focus();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.hidden = true;
    const pw = input.value.trim();
    if (!pw) return;
    try {
      if (await tryPassword(pw)) {
        gate.hidden = true;
        init();
      } else {
        clearAuthPassword();
        errorEl.textContent = "wrong password";
        errorEl.hidden = false;
        input.select();
      }
    } catch (e) {
      clearAuthPassword();
      errorEl.textContent = `error: ${e.message || e}`;
      errorEl.hidden = false;
    }
  });
}

bootstrap();
