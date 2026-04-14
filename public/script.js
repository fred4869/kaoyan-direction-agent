const sessionStorageKey = "kaoyan-agent-session";

const elements = {
  messages: document.querySelector("#messages"),
  stageBadge: document.querySelector("#stageBadge"),
  resetConversation: document.querySelector("#resetConversation"),
  chatForm: document.querySelector("#chatForm"),
  messageInput: document.querySelector("#messageInput"),
  sendButton: document.querySelector("#sendButton"),
  floatingActions: document.querySelector("#floatingActions"),
  openProfile: document.querySelector("#openProfile"),
  openCandidates: document.querySelector("#openCandidates"),
  openRecommendations: document.querySelector("#openRecommendations"),
  profileSheet: document.querySelector("#profileSheet"),
  candidateSheet: document.querySelector("#candidateSheet"),
  recommendationSheet: document.querySelector("#recommendationSheet"),
  profileSummary: document.querySelector("#profileSummary"),
  candidateList: document.querySelector("#candidateList"),
  recommendationList: document.querySelector("#recommendationList"),
};

const state = {
  sessionId: resolveSessionId(),
  messages: [],
  stage: "初始建档",
  flags: {
    profile_ready: false,
    candidates_ready: false,
    recommendation_ready: false,
  },
  researchUpdates: [],
};

init();

async function init() {
  bindEvents();

  try {
    const session = await fetchJson(`/api/session/${state.sessionId}`);
    applySession(session);
    return;
  } catch {
    localStorage.removeItem(sessionStorageKey);
    state.sessionId = createSessionId();
    localStorage.setItem(sessionStorageKey, state.sessionId);
  }

  renderMessages([
    {
      role: "assistant",
      content:
        "我们先把你的情况摸清楚。我会像考研规划师一样，先判断你的基础、偏好和约束，再逐步缩小到适合的学校和专业方向。你可以先告诉我：现在大几、绩点或排名、数学和英语基础、更想留江苏还是可以去外地。",
    },
  ]);
}

function bindEvents() {
  elements.chatForm.addEventListener("submit", onSubmit);
  elements.messageInput.addEventListener("input", autoResize);
  elements.resetConversation.addEventListener("click", resetConversation);
  document.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      elements.messageInput.value = chip.dataset.prompt || "";
      autoResize();
      elements.messageInput.focus();
    });
  });

  elements.openProfile.addEventListener("click", () => openSheet(elements.profileSheet));
  elements.openCandidates.addEventListener("click", () => openSheet(elements.candidateSheet));
  elements.openRecommendations.addEventListener("click", () => openSheet(elements.recommendationSheet));

  document.querySelectorAll("[data-close]").forEach((button) => {
    button.addEventListener("click", () => {
      const target = document.getElementById(button.dataset.close);
      closeSheet(target);
    });
  });
}

async function onSubmit(event) {
  event.preventDefault();

  const message = elements.messageInput.value.trim();
  if (!message) return;

  pushMessage({ role: "user", content: message });
  elements.messageInput.value = "";
  autoResize();
  setSubmitting(true);

  try {
    const data = await fetchJson("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: state.sessionId,
        message,
      }),
    });

    applySession(data);
    if (Array.isArray(data.researchUpdates) && data.researchUpdates.length) {
      const note = data.researchUpdates
        .map((item) =>
          item.status === "updated"
            ? `已联网补录：${item.record.school} ${item.record.program}`
            : item.status === "queued"
              ? `已启动后台核验：${item.school} ${item.program}`
              : `检索未完成：${item.school} ${item.program} (${item.message})`,
        )
        .join("\n");
      pushMessage({ role: "assistant", content: note });
    }
  } catch (error) {
    pushMessage({
      role: "assistant",
      content: `请求失败：${error.message || "请稍后重试"}`,
    });
  } finally {
    setSubmitting(false);
  }
}

function applySession(session) {
  state.messages = session.messages || state.messages;
  state.stage = session.stage || state.stage;
  state.flags = session.flags || state.flags;

  renderMessages(state.messages);
  renderStage(session.stage);
  renderPanels(session);
}

function renderMessages(messages) {
  elements.messages.innerHTML = "";
  messages.forEach((item) => {
    pushMessage(item, false);
  });
}

function pushMessage(message, mutateState = true) {
  if (mutateState) {
    state.messages.push(message);
  }

  const article = document.createElement("article");
  article.className = `message ${message.role}`;
  article.innerHTML = `<div>${escapeHtml(message.content).replace(/\n/g, "<br>")}</div>`;

  elements.messages.appendChild(article);
  window.requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }));
}

function renderStage(stage) {
  elements.stageBadge.textContent = stage || "初始建档";
}

function renderPanels(session) {
  const available = new Set(session.panels_available || []);
  const shouldShowActions = available.size > 0;

  elements.floatingActions.classList.toggle("hidden", !shouldShowActions);
  elements.openProfile.classList.toggle("hidden", !available.has("profile"));
  elements.openCandidates.classList.toggle("hidden", !available.has("candidates"));
  elements.openRecommendations.classList.toggle("hidden", !available.has("recommendations"));

  renderProfile(session.profile?.summary || []);
  renderCandidates(session.candidatePrograms || []);
  renderRecommendations(session.recommendations);
}

function renderProfile(summary) {
  elements.profileSummary.innerHTML = "";
  summary.forEach((line) => {
    const item = document.createElement("div");
    item.className = "summary-item";
    item.textContent = line;
    elements.profileSummary.appendChild(item);
  });
}

function renderCandidates(candidates) {
  elements.candidateList.innerHTML = "";
  candidates.forEach((candidate) => {
    const card = document.createElement("article");
    card.className = "candidate-card";
    const sourceLabel = candidate.sourceType === "official" ? "官方来源" : candidate.sourceType === "secondary" ? "公开整理" : "来源待补";
    card.innerHTML = `
      <h3>${escapeHtml(candidate.school)} · ${escapeHtml(candidate.program)}</h3>
      <div class="candidate-meta">${escapeHtml(candidate.college)} · ${escapeHtml(candidate.degreeType)} · ${escapeHtml(candidate.city)}</div>
      <div class="candidate-meta">考试科目：${escapeHtml(candidate.exam)}</div>
      <div class="candidate-meta">${escapeHtml(candidate.experience)}</div>
      <div class="candidate-meta">核验：${escapeHtml(String(candidate.verifiedYear || "待补"))} · ${escapeHtml(sourceLabel)} · 可信度 ${escapeHtml(candidate.confidence || "unknown")}</div>
      ${
        candidate.sourceUrl
          ? `<div class="candidate-meta"><a class="source-link" href="${escapeHtml(candidate.sourceUrl)}" target="_blank" rel="noreferrer">查看来源</a></div>`
          : ""
      }
      ${candidate.evidenceNote ? `<div class="candidate-meta">${escapeHtml(candidate.evidenceNote)}</div>` : ""}
      <span class="score-pill">匹配分 ${candidate.score} / 难度 ${escapeHtml(candidate.difficultyTag)}</span>
    `;
    elements.candidateList.appendChild(card);
  });
}

function renderRecommendations(recommendations) {
  elements.recommendationList.innerHTML = "";
  if (!recommendations) return;

  [
    ["冲刺", recommendations.sprint || []],
    ["匹配", recommendations.match || []],
    ["保底", recommendations.safe || []],
  ].forEach(([title, list]) => {
    if (!list.length) return;

    const card = document.createElement("section");
    card.className = "group-card";
    card.innerHTML = `<h3>${title}</h3>`;

    list.forEach((program) => {
      const item = document.createElement("div");
      item.className = "program-card";
      const sourceLabel = program.sourceType === "official" ? "官方来源" : program.sourceType === "secondary" ? "公开整理" : "来源待补";
      item.innerHTML = `
        <strong>${escapeHtml(program.school)} · ${escapeHtml(program.program)}</strong>
        <div class="program-meta">${escapeHtml(program.college)} · ${escapeHtml(program.degreeType)} · ${escapeHtml(program.exam)}</div>
        <div class="program-meta">读研体验：${escapeHtml(program.experience)}</div>
        <div class="program-meta">就业导向：${escapeHtml(program.employment)}</div>
        <div class="program-meta">核验：${escapeHtml(String(program.verifiedYear || "待补"))} · ${escapeHtml(sourceLabel)} · 可信度 ${escapeHtml(program.confidence || "unknown")}</div>
        ${
          program.sourceUrl
            ? `<div class="program-meta"><a class="source-link" href="${escapeHtml(program.sourceUrl)}" target="_blank" rel="noreferrer">查看来源</a></div>`
            : ""
        }
      `;
      card.appendChild(item);
    });

    elements.recommendationList.appendChild(card);
  });
}

function openSheet(sheet) {
  sheet.classList.remove("hidden");
  sheet.setAttribute("aria-hidden", "false");
}

function closeSheet(sheet) {
  sheet.classList.add("hidden");
  sheet.setAttribute("aria-hidden", "true");
}

function autoResize() {
  elements.messageInput.style.height = "auto";
  elements.messageInput.style.height = `${Math.min(elements.messageInput.scrollHeight, 132)}px`;
}

function setSubmitting(isSubmitting) {
  elements.sendButton.disabled = isSubmitting;
  elements.resetConversation.disabled = isSubmitting;
  elements.sendButton.textContent = isSubmitting ? "发送中" : "发送";
}

async function resetConversation() {
  closeSheet(elements.profileSheet);
  closeSheet(elements.candidateSheet);
  closeSheet(elements.recommendationSheet);
  elements.messageInput.value = "";
  autoResize();
  setSubmitting(true);

  try {
    state.sessionId = createSessionId();
    localStorage.setItem(sessionStorageKey, state.sessionId);
    const session = await fetchJson(`/api/session/${state.sessionId}`);
    applySession(session);
  } catch (error) {
    renderMessages([
      {
        role: "assistant",
        content: `重新开始失败：${error.message || "请稍后重试"}`,
      },
    ]);
  } finally {
    setSubmitting(false);
  }
}

function resolveSessionId() {
  const stored = localStorage.getItem(sessionStorageKey);
  if (stored && stored !== "primary") {
    return stored;
  }

  const next = createSessionId();
  localStorage.setItem(sessionStorageKey, next);
  return next;
}

function createSessionId() {
  if (globalThis.crypto?.randomUUID) {
    return `session-${globalThis.crypto.randomUUID()}`;
  }

  return `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "请求失败");
  }

  return data;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
