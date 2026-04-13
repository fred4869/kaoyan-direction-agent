const elements = {
  messages: document.querySelector("#messages"),
  stageBadge: document.querySelector("#stageBadge"),
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
  sessionId: localStorage.getItem("kaoyan-agent-session") || "primary",
  messages: [],
  stage: "初始建档",
  flags: {
    profile_ready: false,
    candidates_ready: false,
    recommendation_ready: false,
  },
};

init();

async function init() {
  bindEvents();

  try {
    const session = await fetchJson(`/api/session/${state.sessionId}`);
    applySession(session);
    return;
  } catch {
    localStorage.removeItem("kaoyan-agent-session");
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

    if (!state.sessionId && data.sessionId) {
      state.sessionId = data.sessionId;
      localStorage.setItem("kaoyan-agent-session", data.sessionId);
    }

    applySession(data);
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
    card.innerHTML = `
      <h3>${escapeHtml(candidate.school)} · ${escapeHtml(candidate.program)}</h3>
      <div class="candidate-meta">${escapeHtml(candidate.college)} · ${escapeHtml(candidate.degreeType)} · ${escapeHtml(candidate.city)}</div>
      <div class="candidate-meta">考试科目：${escapeHtml(candidate.exam)}</div>
      <div class="candidate-meta">${escapeHtml(candidate.experience)}</div>
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
      item.innerHTML = `
        <strong>${escapeHtml(program.school)} · ${escapeHtml(program.program)}</strong>
        <div class="program-meta">${escapeHtml(program.college)} · ${escapeHtml(program.degreeType)} · ${escapeHtml(program.exam)}</div>
        <div class="program-meta">读研体验：${escapeHtml(program.experience)}</div>
        <div class="program-meta">就业导向：${escapeHtml(program.employment)}</div>
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
  elements.sendButton.textContent = isSubmitting ? "发送中" : "发送";
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
