import "dotenv/config";
import * as cheerio from "cheerio";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT || 3030);
const dashscopeApiKey = process.env.DASHSCOPE_API_KEY || "";
const dashscopeBaseUrl = (process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/+$/, "");
const dashscopeModel = process.env.DASHSCOPE_MODEL || "qwen-max-latest";
const defaultSessionId = process.env.DEFAULT_SESSION_ID || "primary";
const dataDir = path.join(__dirname, "data");
const sessionsDir = path.join(dataDir, "sessions");
const knowledgeBaseFilePath = path.join(dataDir, "knowledge-base.json");
const maxWindowMessages = 10;
const retainWindowMessages = 6;
const webSearchTimeoutMs = Number(process.env.WEB_SEARCH_TIMEOUT_MS || 3500);
const webFetchTimeoutMs = Number(process.env.WEB_FETCH_TIMEOUT_MS || 3500);

const primarySession = loadSession(defaultSessionId);
const sessionCache = new Map([[defaultSessionId, primarySession]]);
let knowledgeBase = loadKnowledgeBase();
const researchInFlight = new Set();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    modelConfigured: Boolean(dashscopeApiKey),
    model: dashscopeModel,
    baseUrl: dashscopeBaseUrl,
  });
});

app.get("/api/session/:sessionId", (req, res) => {
  const session = getOrCreateSession(req.params.sessionId);
  res.json(buildSessionPayload(session));
});

app.get("/api/knowledge-base", (_req, res) => {
  res.json({
    count: knowledgeBase.length,
    items: knowledgeBase,
  });
});

app.post("/api/research/program", async (req, res) => {
  try {
    const school = String(req.body.school || "").trim();
    const program = String(req.body.program || "").trim();

    if (!school || !program) {
      return res.status(400).json({ error: "school and program are required" });
    }

    const result = await researchProgramAndUpdateKnowledgeBase({ school, program });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message || "Research failed" });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const sessionId = String(req.body.sessionId || defaultSessionId);
    const userMessage = String(req.body.message || "").trim();

    if (!userMessage) {
      return res.status(400).json({ error: "message is required" });
    }

    const session = getOrCreateSession(sessionId);
    const researchUpdates = queueResearchFromMessage(session, userMessage);
    const userEntry = { role: "user", content: userMessage, timestamp: Date.now() };
    session.conversationLog.push(userEntry);
    session.conversationWindow.push(userEntry);

    updateSessionFromMessage(session, userMessage);
    maybeUnlockCandidates(session);
    maybeUnlockRecommendations(session);
    refreshWorkingMemory(session);
    refreshCaseWorkspace(session, { latestUserMessage: userMessage, researchUpdates });

    const assistantMessage = dashscopeApiKey
      ? await generateDashScopeReply(session, userMessage)
      : generateLocalReply(session, userMessage);

    const assistantEntry = { role: "assistant", content: assistantMessage, timestamp: Date.now() };
    session.conversationLog.push(assistantEntry);
    session.conversationWindow.push(assistantEntry);
    compressConversation(session);
    refreshWorkingMemory(session);
    refreshCaseWorkspace(session, { latestUserMessage: userMessage, researchUpdates, assistantMessage });
    persistSession(session);

    res.json({
      sessionId,
      reply: assistantMessage,
      researchUpdates,
      ...buildSessionPayload(session),
    });
  } catch (error) {
    res.status(500).json({
      error: error.message || "Unexpected server error",
    });
  }
});

app.listen(port, () => {
  console.log(`Kaoyan agent running at http://localhost:${port}`);
});

function createSession(sessionId = defaultSessionId) {
  const initialMessage = {
    role: "assistant",
    content:
      "我们先把你的情况摸清楚。我会像考研规划师一样，先判断你的基础、偏好和约束，再逐步缩小到适合的学校和专业方向。你可以先告诉我：现在大几、绩点或排名、数学和英语基础、更想留江苏还是可以去外地。",
    timestamp: Date.now(),
  };

  return {
    id: sessionId,
    stage: "初始建档",
    flags: {
      profile_ready: false,
      candidates_ready: false,
      recommendation_ready: false,
    },
    panels_available: [],
    conversationLog: [initialMessage],
    conversationWindow: [initialMessage],
    conversationArchive: [],
    workingMemory: {
      currentFocus: "先收集基础画像，确认学业水平、考试基础、地域偏好和就业/学术倾向。",
      confirmedFacts: ["本科背景：河海大学 物理专业"],
      openQuestions: ["现在大几", "绩点或排名大概如何", "数学和英语基础怎么样", "更倾向留江苏还是可接受外地"],
      latestSummary: "会话刚开始，尚未形成稳定画像。",
      compressedTurns: 0,
      archiveCount: 0,
    },
    profile: {
      major: "物理专业",
      school: "河海大学",
      year: "",
      gpa: "",
      ranking: "",
      mathLevel: "",
      englishLevel: "",
      interest: [],
      locations: [],
      degreePreference: "",
      careerPreference: "",
      riskTolerance: "",
      constraints: [],
      notes: [],
    },
    candidatePrograms: [],
    recommendations: null,
    caseWorkspace: {
      studentCase: {
        title: "河海大学物理专业考研案例",
        objective: "在几天到几周内持续收集信息，逐步收敛到最适合的考研方向与院校组合。",
        stableProfile: ["本科背景：河海大学 物理专业"],
        evolvingPreferences: [],
        constraints: [],
        unknowns: ["当前年级", "绩点或排名", "数学基础", "英语基础", "地域偏好", "学位接受度"],
        timeline: [
          {
            id: `timeline-${Date.now()}`,
            timestamp: new Date().toISOString(),
            type: "session_created",
            summary: "已创建新的长期规划案例。",
          },
        ],
      },
      evidenceVault: [],
      researchQueue: [],
      decisionSnapshots: [],
      lastRecommendationHash: "",
    },
    updatedAt: new Date().toISOString(),
  };
}

function getOrCreateSession(sessionId) {
  if (sessionCache.has(sessionId)) {
    return sessionCache.get(sessionId);
  }

  const session = loadSession(sessionId);
  sessionCache.set(sessionId, session);
  return session;
}

function loadSession(sessionId = defaultSessionId) {
  ensureDataDir();
  const sessionFilePath = getSessionFilePath(sessionId);

  if (!fs.existsSync(sessionFilePath)) {
    const seed = createSession(sessionId);
    writeSession(seed);
    return seed;
  }

  try {
    const raw = fs.readFileSync(sessionFilePath, "utf8");
    return normalizeSession(JSON.parse(raw));
  } catch {
    const seed = createSession(sessionId);
    writeSession(seed);
    return seed;
  }
}

function loadKnowledgeBase() {
  ensureDataDir();

  if (!fs.existsSync(knowledgeBaseFilePath)) {
    const seeded = buildKnowledgeBase();
    fs.writeFileSync(knowledgeBaseFilePath, JSON.stringify(seeded, null, 2), "utf8");
    return seeded;
  }

  try {
    const raw = fs.readFileSync(knowledgeBaseFilePath, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      const sanitized = sanitizeKnowledgeBase(parsed);
      fs.writeFileSync(knowledgeBaseFilePath, JSON.stringify(sanitized, null, 2), "utf8");
      return sanitized;
    }
  } catch {
    // fall through to seed
  }

  const seeded = buildKnowledgeBase();
  fs.writeFileSync(knowledgeBaseFilePath, JSON.stringify(seeded, null, 2), "utf8");
  return seeded;
}

function sanitizeKnowledgeBase(items) {
  const deduped = new Map();

  for (const item of items) {
    const cleanedSchool = cleanSchoolName(item.school || "");
    if (!isValidSchoolName(cleanedSchool)) continue;
    if (!isKnowledgeRecordUsable({ ...item, school: cleanedSchool })) continue;

    const normalized = {
      ...item,
      school: cleanedSchool,
    };
    const key = `${normalized.school}__${normalized.program}`;
    deduped.set(key, normalized);
  }

  return [...deduped.values()];
}

function persistKnowledgeBase() {
  ensureDataDir();
  fs.writeFileSync(knowledgeBaseFilePath, JSON.stringify(knowledgeBase, null, 2), "utf8");
}

function persistSession(session) {
  const normalized = normalizeSession(session);
  writeSession(normalized);
}

function writeSession(session) {
  ensureDataDir();
  const sessionFilePath = getSessionFilePath(session.id || defaultSessionId);
  session.updatedAt = new Date().toISOString();
  fs.writeFileSync(sessionFilePath, JSON.stringify(session, null, 2), "utf8");
}

function ensureDataDir() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });
}

function getSessionFilePath(sessionId) {
  return path.join(sessionsDir, `${sanitizeSessionId(sessionId)}.json`);
}

function sanitizeSessionId(sessionId) {
  return String(sessionId || defaultSessionId).replace(/[^a-zA-Z0-9-_]/g, "_");
}

function normalizeSession(session) {
  if (!session || typeof session !== "object") {
    return createSession();
  }

  const normalized = createSession(session.id || defaultSessionId);
  normalized.id = session.id || normalized.id;
  normalized.stage = session.stage || normalized.stage;
  normalized.flags = session.flags || normalized.flags;
  normalized.panels_available = session.panels_available || normalized.panels_available;
  normalized.profile = { ...normalized.profile, ...(session.profile || {}) };
  normalized.candidatePrograms = session.candidatePrograms || normalized.candidatePrograms;
  normalized.recommendations = session.recommendations || normalized.recommendations;
  normalized.updatedAt = session.updatedAt || normalized.updatedAt;
  normalized.conversationLog = session.conversationLog || session.messages || normalized.conversationLog;
  normalized.conversationWindow = session.conversationWindow || session.messages || normalized.conversationWindow;
  normalized.conversationArchive = session.conversationArchive || normalized.conversationArchive;
  normalized.workingMemory = session.workingMemory || normalized.workingMemory;
  normalized.caseWorkspace = {
    ...normalized.caseWorkspace,
    ...(session.caseWorkspace || {}),
    studentCase: {
      ...normalized.caseWorkspace.studentCase,
      ...((session.caseWorkspace && session.caseWorkspace.studentCase) || {}),
    },
  };
  refreshWorkingMemory(normalized);
  refreshCaseWorkspace(normalized, { latestUserMessage: "", researchUpdates: [] });
  return normalized;
}

function buildSessionPayload(session) {
  return {
    sessionId: session.id,
    stage: session.stage,
    profile: {
      summary: buildProfileSummary(session.profile),
      detail: session.profile,
    },
    flags: session.flags,
    panels_available: session.panels_available,
    candidatePrograms: session.candidatePrograms.slice(0, 8),
    recommendations: session.recommendations,
    messages: session.conversationLog,
    memory: {
      currentFocus: session.workingMemory.currentFocus,
      confirmedFacts: session.workingMemory.confirmedFacts,
      openQuestions: session.workingMemory.openQuestions,
      latestSummary: session.workingMemory.latestSummary,
      archiveCount: session.workingMemory.archiveCount,
      compressedTurns: session.workingMemory.compressedTurns,
    },
    workspace: buildWorkspacePayload(session),
  };
}

function buildWorkspacePayload(session) {
  const workspace = session.caseWorkspace;
  return {
    studentCase: workspace.studentCase,
    evidenceVault: workspace.evidenceVault.slice(0, 24),
    researchQueue: workspace.researchQueue.slice(0, 20),
    decisionSnapshots: workspace.decisionSnapshots.slice(0, 12),
    summary: {
      stableProfileCount: workspace.studentCase.stableProfile.length,
      evidenceCount: workspace.evidenceVault.length,
      researchQueueCount: workspace.researchQueue.length,
      pendingResearchCount: workspace.researchQueue.filter((item) => item.status !== "done").length,
      snapshotCount: workspace.decisionSnapshots.length,
    },
  };
}

function refreshCaseWorkspace(session, { latestUserMessage = "", researchUpdates = [], assistantMessage = "" }) {
  const workspace = session.caseWorkspace;
  const studentCase = workspace.studentCase;

  studentCase.stableProfile = buildProfileSummary(session.profile);
  studentCase.evolvingPreferences = [
    session.profile.degreePreference ? `学位接受度：${session.profile.degreePreference}` : "",
    session.profile.careerPreference ? `目标导向：${session.profile.careerPreference}` : "",
    session.profile.riskTolerance ? `风险偏好：${session.profile.riskTolerance}` : "",
    session.profile.interest.length ? `方向偏好：${session.profile.interest.join("、")}` : "",
    session.profile.locations.length ? `地域范围：${session.profile.locations.join("、")}` : "",
  ].filter(Boolean);
  studentCase.constraints = session.profile.constraints.slice(0, 12);
  studentCase.unknowns = session.workingMemory.openQuestions.slice(0, 12);
  studentCase.lastUpdatedAt = new Date().toISOString();

  if (latestUserMessage) {
    pushTimelineEvent(session, {
      type: "user_update",
      summary: `学生补充：${truncate(latestUserMessage, 120)}`,
      dedupeKey: `user:${latestUserMessage}`,
    });
  }

  if (assistantMessage) {
    pushTimelineEvent(session, {
      type: "assistant_update",
      summary: `顾问判断：${truncate(assistantMessage, 120)}`,
      dedupeKey: `assistant:${assistantMessage}`,
    });
  }

  syncEvidenceVault(session, researchUpdates);
  syncResearchQueue(session, latestUserMessage, researchUpdates);
  maybeCreateDecisionSnapshot(session);
  trimWorkspace(session);
}

function pushTimelineEvent(session, { type, summary, dedupeKey }) {
  const timeline = session.caseWorkspace.studentCase.timeline;
  const last = timeline[timeline.length - 1];
  if (last?.dedupeKey === dedupeKey) return;

  timeline.push({
    id: `timeline-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    type,
    summary,
    dedupeKey,
  });
}

function syncEvidenceVault(session, researchUpdates) {
  const evidenceVault = session.caseWorkspace.evidenceVault;

  for (const item of session.candidatePrograms.slice(0, 5)) {
    upsertEvidenceItem(evidenceVault, {
      id: `candidate-${item.school}-${item.program}`,
      title: `${item.school} ${item.program}`,
      kind: "candidate",
      summary: `候选项目，${item.degreeType}，考试科目 ${item.exam}，当前匹配分 ${item.score}。${item.experience}`,
      sourceType: item.sourceType,
      sourceUrl: item.sourceUrl,
      verifiedYear: item.verifiedYear,
      status: "active",
      relevance: "high",
      updatedAt: new Date().toISOString(),
    });
  }

  const recommendationPrograms = [
    ...(session.recommendations?.match || []),
    ...(session.recommendations?.sprint || []),
    ...(session.recommendations?.safe || []),
  ];
  for (const item of recommendationPrograms.slice(0, 6)) {
    upsertEvidenceItem(evidenceVault, {
      id: `recommendation-${item.school}-${item.program}`,
      title: `${item.school} ${item.program}`,
      kind: "recommendation",
      summary: `当前进入${classifyRecommendationBucket(session.recommendations, item)}档。就业：${item.employment} 体验：${item.experience}`,
      sourceType: item.sourceType,
      sourceUrl: item.sourceUrl,
      verifiedYear: item.verifiedYear,
      status: "active",
      relevance: "high",
      updatedAt: new Date().toISOString(),
    });
  }

  for (const update of researchUpdates) {
    const record = update.record;
    upsertEvidenceItem(evidenceVault, {
      id: `research-${update.school}-${update.program}`,
      title: `${update.school} ${update.program}`,
      kind: "research",
      summary:
        update.status === "queued"
          ? "已排入后台核验，等待官方来源或较高可信度来源补录。"
          : record
            ? `已补录到知识库。来源：${record.sourceType}，年份：${record.verifiedYear || "待补"}。`
            : update.message || "研究任务已创建。",
      sourceType: record?.sourceType || "pending",
      sourceUrl: record?.sourceUrl || "",
      verifiedYear: record?.verifiedYear || "",
      status: update.status === "queued" ? "pending" : "active",
      relevance: "medium",
      updatedAt: new Date().toISOString(),
    });
  }
}

function upsertEvidenceItem(evidenceVault, next) {
  const index = evidenceVault.findIndex((item) => item.id === next.id);
  if (index >= 0) {
    evidenceVault[index] = { ...evidenceVault[index], ...next };
  } else {
    evidenceVault.unshift(next);
  }
}

function syncResearchQueue(session, latestUserMessage, researchUpdates) {
  const queue = session.caseWorkspace.researchQueue;
  const now = new Date().toISOString();

  for (const question of session.workingMemory.openQuestions.slice(0, 6)) {
    upsertResearchTask(queue, {
      id: `question-${question}`,
      subject: question,
      status: "pending",
      priority: inferQuestionPriority(question),
      reason: "这是当前最影响判断准确性的缺口信息之一。",
      createdAt: now,
      updatedAt: now,
    });
  }

  for (const update of researchUpdates) {
    upsertResearchTask(queue, {
      id: `research-${update.school}-${update.program}`,
      subject: `${update.school} ${update.program}`,
      status: update.status === "queued" ? "in_progress" : update.status === "updated" ? "done" : "blocked",
      priority: "high",
      reason: update.message || "由聊天中新增的学校/专业触发。",
      createdAt: now,
      updatedAt: now,
    });
  }

  if (/导师|复试|就业|城市|学费|住宿/.test(latestUserMessage || "")) {
    upsertResearchTask(queue, {
      id: `topic-${truncate(latestUserMessage, 36)}`,
      subject: truncate(latestUserMessage, 36),
      status: "pending",
      priority: "medium",
      reason: "学生主动提出了新的决策主题，需要补证据后再判断。",
      createdAt: now,
      updatedAt: now,
    });
  }

  const openSet = new Set(session.workingMemory.openQuestions);
  for (const item of queue) {
    if (item.id.startsWith("question-") && !openSet.has(item.subject)) {
      item.status = "done";
      item.updatedAt = now;
    }
  }
}

function upsertResearchTask(queue, next) {
  const index = queue.findIndex((item) => item.id === next.id);
  if (index >= 0) {
    queue[index] = { ...queue[index], ...next };
  } else {
    queue.unshift(next);
  }
}

function inferQuestionPriority(question) {
  if (/绩点|排名|数学|英语/.test(question)) return "high";
  if (/学硕|专硕|就业|科研|风险偏好/.test(question)) return "high";
  return "medium";
}

function maybeCreateDecisionSnapshot(session) {
  const workspace = session.caseWorkspace;
  const recommendationHash = JSON.stringify({
    stage: session.stage,
    match: (session.recommendations?.match || []).map((item) => `${item.school}${item.program}`),
    sprint: (session.recommendations?.sprint || []).map((item) => `${item.school}${item.program}`),
    safe: (session.recommendations?.safe || []).map((item) => `${item.school}${item.program}`),
    openQuestions: session.workingMemory.openQuestions,
  });

  if (workspace.lastRecommendationHash === recommendationHash) return;
  if (!session.flags.profile_ready) return;

  const snapshot = {
    id: `snapshot-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    stage: session.stage,
    headline: buildSnapshotHeadline(session),
    summary: session.workingMemory.latestSummary,
    blockingQuestions: session.workingMemory.openQuestions.slice(0, 6),
    recommendations: {
      sprint: (session.recommendations?.sprint || []).map((item) => `${item.school}${item.program}`),
      match: (session.recommendations?.match || []).map((item) => `${item.school}${item.program}`),
      safe: (session.recommendations?.safe || []).map((item) => `${item.school}${item.program}`),
    },
  };

  workspace.decisionSnapshots.unshift(snapshot);
  workspace.lastRecommendationHash = recommendationHash;
}

function buildSnapshotHeadline(session) {
  if (!session.flags.candidates_ready) {
    return "画像仍在收集阶段，尚未形成稳定候选。";
  }
  if (!session.flags.recommendation_ready) {
    const top = session.candidatePrograms.slice(0, 2).map((item) => `${item.school}${item.program}`).join("、");
    return `已形成第一批候选：${top || "待补"}。`;
  }
  const topMatch = session.recommendations?.match?.[0];
  return `当前最优先深挖的是 ${topMatch ? `${topMatch.school}${topMatch.program}` : "匹配档项目"}。`;
}

function classifyRecommendationBucket(recommendations, item) {
  if (recommendations?.sprint?.some((entry) => entry.school === item.school && entry.program === item.program)) return "冲刺";
  if (recommendations?.safe?.some((entry) => entry.school === item.school && entry.program === item.program)) return "保底";
  return "匹配";
}

function trimWorkspace(session) {
  const workspace = session.caseWorkspace;
  workspace.studentCase.timeline = workspace.studentCase.timeline.slice(-40);
  workspace.evidenceVault = workspace.evidenceVault.slice(0, 40);
  workspace.researchQueue = workspace.researchQueue.slice(0, 30);
  workspace.decisionSnapshots = workspace.decisionSnapshots.slice(0, 16);
}

function buildProfileSummary(profile) {
  const lines = [];
  lines.push(`本科背景：${profile.school} ${profile.major}`);
  if (profile.year) lines.push(`当前年级：${profile.year}`);
  if (profile.gpa || profile.ranking) lines.push(`学业情况：${[profile.gpa, profile.ranking].filter(Boolean).join(" / ")}`);
  if (profile.mathLevel || profile.englishLevel) lines.push(`考试基础：${[profile.mathLevel, profile.englishLevel].filter(Boolean).join(" / ")}`);
  if (profile.locations.length) lines.push(`地域偏好：${profile.locations.join("、")}`);
  if (profile.interest.length) lines.push(`兴趣方向：${profile.interest.join("、")}`);
  if (profile.degreePreference) lines.push(`学位倾向：${profile.degreePreference}`);
  if (profile.careerPreference) lines.push(`目标导向：${profile.careerPreference}`);
  if (profile.riskTolerance) lines.push(`风险偏好：${profile.riskTolerance}`);
  if (profile.constraints.length) lines.push(`现实约束：${profile.constraints.join("；")}`);
  return lines;
}

function updateSessionFromMessage(session, message) {
  const text = message.toLowerCase();
  const profile = session.profile;

  if (/大一|大二|大三|大四|研一/.test(message)) {
    profile.year = (message.match(/大一|大二|大三|大四|研一/) || [""])[0];
  }
  if (/绩点|gpa/.test(text)) {
    profile.gpa = extractNumberChunk(message, /(绩点|gpa)[^\d]*(\d(?:\.\d+)?)/i) || profile.gpa;
  }
  if (/排名|前\d+%|前百分之/.test(message)) {
    profile.ranking = extractRanking(message) || profile.ranking;
  }
  if (/英语|六级|四级|cet[-\s]?[46]|考研英语/.test(text)) {
    profile.englishLevel = summarizeEnglish(message);
  }
  if (/数学|高数|数一|数二/.test(message)) {
    profile.mathLevel = summarizeMath(message);
  }
  if (/江苏|南京|苏州|上海|杭州|成都|四川|湖南|长沙|外地|家里/.test(message)) {
    profile.locations = dedupe([...profile.locations, ...extractLocations(message)]);
  }
  if (/物理学|光学工程|光电|电子信息|仪器|半导体|材料|师范/.test(message)) {
    profile.interest = dedupe([...profile.interest, ...extractInterests(message)]);
  }
  if (/学硕|专硕|都可以/.test(message)) {
    profile.degreePreference = extractDegreePreference(message);
  }
  if (/就业|读博|科研|工作|稳定|薪资|城市/.test(message)) {
    profile.careerPreference = extractCareerPreference(message);
  }
  if (/稳|保守|冲一冲|想冲|求稳|能接受调剂|不想太难/.test(message)) {
    profile.riskTolerance = extractRiskTolerance(message);
  }
  if (/家里|预算|不想离家|不能|必须|接受不了|不想纯物理|不太想纯物理|不考虑纯物理/.test(message)) {
    profile.constraints = dedupe([...profile.constraints, message]);
  }

  const profileDataPoints = [
    profile.year,
    profile.gpa || profile.ranking,
    profile.mathLevel,
    profile.englishLevel,
    profile.locations.length ? "1" : "",
    profile.interest.length ? "1" : "",
    profile.degreePreference,
    profile.careerPreference,
  ].filter(Boolean).length;

  if (profileDataPoints >= 4) {
    session.flags.profile_ready = true;
    session.stage = "方向澄清";
    ensurePanel(session, "profile");
  }

  if (isCandidateExplorationReady(profile)) {
    session.stage = "候选扩展";
  }
}

function maybeUnlockCandidates(session) {
  if (!session.flags.profile_ready || !isCandidateExplorationReady(session.profile)) {
    session.flags.candidates_ready = false;
    session.candidatePrograms = [];
    return;
  }

  session.candidatePrograms = scoreCandidates(session.profile, knowledgeBase).slice(0, 8);
  session.flags.candidates_ready = session.candidatePrograms.length > 0;

  if (session.flags.candidates_ready) {
    session.stage = "候选扩展";
    ensurePanel(session, "candidates");
  }
}

function maybeUnlockRecommendations(session) {
  if (!session.flags.candidates_ready) return;

  if (!isRecommendationReady(session.profile)) {
    session.flags.recommendation_ready = false;
    session.recommendations = null;
    return;
  }

  session.recommendations = buildRecommendations(session.candidatePrograms);
  session.flags.recommendation_ready = true;
  session.stage = "结论生成";
  ensurePanel(session, "recommendations");
}

function ensurePanel(session, panel) {
  if (!session.panels_available.includes(panel)) {
    session.panels_available.push(panel);
  }
}

function refreshWorkingMemory(session) {
  const confirmedFacts = buildProfileSummary(session.profile);
  const priorityCandidates = getPriorityCandidates(session);

  if (priorityCandidates.length) {
    confirmedFacts.push(
      "当前优先候选：" + priorityCandidates.map((item) => `${item.school}${item.program}`).join("、"),
    );
  }

  const latestMessages = session.conversationWindow
    .slice(-4)
    .map((item) => `${item.role === "user" ? "她" : "顾问"}：${item.content}`)
    .join(" ");

  session.workingMemory = {
    currentFocus: inferCurrentFocus(session),
    confirmedFacts,
    openQuestions: inferOpenQuestions(session.profile, session.flags),
    latestSummary: buildWorkingSummary(session, latestMessages),
    compressedTurns: session.conversationArchive.reduce((sum, item) => sum + item.messageCount, 0),
    archiveCount: session.conversationArchive.length,
  };
}

function inferOpenQuestions(profile, flags) {
  const open = [];
  if (!profile.year) open.push("当前年级");
  if (!profile.gpa && !profile.ranking) open.push("绩点或排名");
  if (!profile.mathLevel) open.push("数学基础");
  if (!profile.englishLevel) open.push("英语基础");
  if (!profile.locations.length) open.push("地域偏好");
  if (!profile.degreePreference) open.push("学硕/专硕接受度");
  if (!profile.careerPreference) open.push("更偏就业还是科研");
  if (!profile.riskTolerance) open.push("风险偏好（求稳还是愿意冲）");
  if (flags.candidates_ready && !profile.interest.length) open.push("更偏物理、光电、电子信息还是仪器");
  return open;
}

function inferCurrentFocus(session) {
  if (!session.flags.profile_ready) return "补齐基础画像，避免过早给学校名单。";
  if (!session.flags.candidates_ready) return "根据画像把方向收敛到更合适的专业赛道。";
  if (!session.flags.recommendation_ready) return "对候选项目做难度、体验和就业的排序。";
  return "在已有分层推荐上继续解释原因，并根据新偏好微调排序。";
}

function buildWorkingSummary(session, latestMessages) {
  const topCandidates = getPriorityCandidates(session)
    .slice(0, 2)
    .map((item) => `${item.school}${item.program}`)
    .join("、");

  return [
    `当前阶段为${session.stage}。`,
    session.flags.profile_ready ? "学生画像已形成初步判断。" : "学生画像仍不完整。",
    topCandidates ? `当前排序靠前的是${topCandidates}。` : "暂未形成稳定候选。",
    latestMessages ? `最近对话集中在：${latestMessages}` : "",
  ]
    .filter(Boolean)
    .join("");
}

function compressConversation(session) {
  if (session.conversationWindow.length <= maxWindowMessages) return;

  const compressCount = session.conversationWindow.length - retainWindowMessages;
  const toCompress = session.conversationWindow.splice(0, compressCount);

  session.conversationArchive.push({
    createdAt: new Date().toISOString(),
    messageCount: toCompress.length,
    summary: summarizeMessages(toCompress),
  });
}

function summarizeMessages(messages) {
  const userPoints = [];
  const assistantPoints = [];

  for (const message of messages) {
    const trimmed = message.content.replace(/\s+/g, " ").trim();
    if (!trimmed) continue;

    if (message.role === "user") {
      userPoints.push(trimmed);
    } else {
      assistantPoints.push(trimmed);
    }
  }

  return [
    userPoints.length ? `学生补充了：${truncate(userPoints.slice(-3).join("；"), 180)}` : "",
    assistantPoints.length ? `顾问回应了：${truncate(assistantPoints.slice(-2).join("；"), 180)}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

async function generateDashScopeReply(session, userMessage) {
  const response = await fetch(`${dashscopeBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${dashscopeApiKey}`,
    },
    body: JSON.stringify({
      model: dashscopeModel,
      temperature: 0.4,
      messages: [
        { role: "system", content: buildSystemPrompt(session) },
        ...session.conversationWindow.slice(-8).map((item) => ({
          role: item.role,
          content: item.content,
        })),
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`DashScope request failed: ${response.status} ${text}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() || generateLocalReply(session, userMessage);
}

function buildSystemPrompt(session) {
  const archiveSummary = session.conversationArchive
    .slice(-3)
    .map((item, index) => `摘要${index + 1}：${item.summary}`)
    .join("\n");

  return [
    "你是一名专业、严谨、克制的中国考研规划师。",
    "你的任务是帮助一名河海大学物理专业学生，通过自然语言对话逐步确定考研方向。",
    "你必须优先做三件事：识别信息缺口、解释当前判断、提出下一步最关键的问题。",
    "输出风格要求：简洁、具体、像真实顾问，不空泛，不灌鸡汤。",
    "你要综合考虑：考试难度、科目匹配、学校层次、城市、读研体验、就业出口、学硕专硕差异。",
    "当前阶段：" + session.stage,
    "当前画像摘要：\n" + buildProfileSummary(session.profile).join("\n"),
    "当前工作记忆：\n" +
      [
        `当前焦点：${session.workingMemory.currentFocus}`,
        `已确认：${session.workingMemory.confirmedFacts.join("；") || "暂无"}`,
        `待确认：${session.workingMemory.openQuestions.join("；") || "暂无"}`,
        `阶段摘要：${session.workingMemory.latestSummary}`,
      ].join("\n"),
    "历史压缩摘要：\n" + (archiveSummary || "暂无"),
    "候选项目（如果已有）：\n" +
      (session.candidatePrograms.length
        ? session.candidatePrograms
            .slice(0, 5)
            .map((item) => `${item.school} ${item.program} ${item.degreeType} 难度${item.difficultyTag} 匹配分${item.score}`)
            .join("\n")
        : "暂无"),
    "请遵守：",
    "1. 未确定结论前，不要一次性给大量学校名单。",
    "2. 先口头判断，再明确你还需要确认什么。",
    "3. 如果推荐学校，优先解释为什么适合或不适合。",
    "4. 回复使用中文。",
  ].join("\n");
}

function generateLocalReply(session, userMessage = "") {
  if (!session.flags.profile_ready) {
    return "我先不急着给学校。就目前信息，我还缺几项会显著影响判断的内容：一是你现在在年级和排名大概处于什么位置；二是数学和英语分别到什么水平；三是你更倾向留江苏还是能接受外地。把这三项补齐后，我就能开始收缩方向。";
  }

  if (session.flags.profile_ready && !session.flags.candidates_ready) {
    const missing = session.workingMemory.openQuestions.slice(0, 3).join("、");
    return `你的基础画像已经有雏形了，但我还不应该太快给学校名单。当前还缺 ${missing || "几项关键信息"}，尤其是会直接影响难度判断和学硕/专硕分流的部分。你先把这些补上，我再进入候选扩展。`;
  }

  if (session.flags.candidates_ready && !session.flags.recommendation_ready) {
    const top = session.candidatePrograms.slice(0, 3).map((item) => `${item.school}${item.program}`).join("、");
    const missing = session.workingMemory.openQuestions.slice(0, 2).join("、");
    return `我已经能给出第一批候选了，当前比较贴近你的有 ${top}。但我还不想过早定结论，因为还有 ${missing || "几个关键信息"} 没确认，它们会继续改变排序。你下一条直接补这部分，我再把建议收紧。`;
  }

  if (shouldDeepDiveRecommendation(userMessage)) {
    return buildRecommendationDeepDive(session, userMessage);
  }

  const topMatch = session.recommendations?.match?.[0];
  const openQuestions = session.workingMemory.openQuestions;

  if (openQuestions.length) {
    return `我已经形成初步分层建议，当前最值得优先深挖的是 ${topMatch ? `${topMatch.school}${topMatch.program}` : "匹配档项目"}。不过还有 ${openQuestions.join("、")} 这些点没完全确认，它们会继续影响排序。你可以任选一个先补充，我再把建议收紧。`;
  }

  return `基于目前信息，我已经形成分层建议。你现在最值得优先深挖的是 ${topMatch ? `${topMatch.school}${topMatch.program}` : "匹配档项目"}。如果你愿意，我下一轮可以继续把每个候选拆开讲清楚：考试科目难点、读研体验、就业出口、以及为什么它比另外几个更适合你。`;
}

function shouldDeepDiveRecommendation(text) {
  return /我愿意|继续|展开|详细说|具体说|细讲|讲讲|为什么|对比|比较|拆开讲|看看细节|行|好/.test(text);
}

function buildRecommendationDeepDive(session, userMessage) {
  const topMatch = session.recommendations?.match?.[0] || session.candidatePrograms[0];
  const secondMatch = session.recommendations?.match?.[1] || session.candidatePrograms[1];

  if (!topMatch) {
    return "我可以继续展开，但你这边还没有形成稳定候选。你先把绩点/排名、英语数学、地域和学位接受度补齐，我再给你拆开讲。";
  }

  if (/对比|比较/.test(userMessage) && secondMatch) {
    return [
      `先对比你现在最该看的两个项目：${topMatch.school}${topMatch.program} 和 ${secondMatch.school}${secondMatch.program}。`,
      `${topMatch.school}${topMatch.program}：考试科目是 ${topMatch.exam}，更适合你的原因是 ${topMatch.experience}${topMatch.employment}`,
      `${secondMatch.school}${secondMatch.program}：考试科目是 ${secondMatch.exam}，它的特点是 ${secondMatch.experience}${secondMatch.employment}`,
      "如果你更看重上岸稳妥，我会先保留前者；如果你更想保住学硕或研究延展性，再重点比较第二个。",
    ].join("");
  }

  return [
    `那我先把 ${topMatch.school}${topMatch.program} 拆开讲。`,
    `考试科目上，它是 ${topMatch.exam}，对应你现在的基础，${inferExamFit(topMatch, session.profile)}`,
    `读研体验上，${topMatch.experience}`,
    `就业上，${topMatch.employment}`,
    secondMatch
      ? `它目前排在前面的原因，也在于它比 ${secondMatch.school}${secondMatch.program} 更贴合你现在“${session.profile.careerPreference || "当前目标"}、${session.profile.riskTolerance || "当前风险偏好"}”这组条件。`
      : "它目前排在前面，是因为它和你当前画像的匹配度最高。 ",
    "如果你继续，我下一条就把第二、第三个候选也拆开，并直接讲它们为什么排在这个项目后面。",
  ].join("");
}

function inferExamFit(program, profile) {
  const comments = [];
  if (profile.mathLevel.includes("对数一有顾虑") && program.exam.includes("数一")) {
    comments.push("它的主要压力点在数一，这会拉高你的复习成本");
  } else if (profile.mathLevel && /数二/.test(program.exam)) {
    comments.push("它对你现在更偏数二的状态相对友好");
  }
  if (profile.englishLevel.includes("偏弱") && /英一/.test(program.exam)) {
    comments.push("英语一会比英语二更吃力一些");
  } else if (profile.englishLevel && /英二/.test(program.exam)) {
    comments.push("英语要求相对可控");
  }
  if (!comments.length) {
    comments.push("整体科目结构和你当前基础没有明显硬冲突");
  }
  return comments.join("，") + "。";
}

function isRecommendationReady(profile) {
  return Boolean(
    profile.year &&
      (profile.gpa || profile.ranking) &&
      profile.mathLevel &&
      profile.englishLevel &&
      profile.locations.length &&
      profile.interest.length &&
      profile.degreePreference &&
      profile.careerPreference &&
      (profile.riskTolerance || profile.constraints.length),
  );
}

function isCandidateExplorationReady(profile) {
  return Boolean(
    profile.year &&
      profile.locations.length &&
      (profile.interest.length || profile.careerPreference) &&
      (profile.mathLevel || profile.englishLevel) &&
      (profile.gpa || profile.ranking || profile.degreePreference || profile.riskTolerance || profile.constraints.length),
  );
}

function getPriorityCandidates(session) {
  if (!session.recommendations) {
    return session.candidatePrograms.slice(0, 3);
  }

  return [
    ...(session.recommendations.match || []),
    ...(session.recommendations.sprint || []),
    ...(session.recommendations.safe || []),
  ].slice(0, 3);
}

function buildKnowledgeBase() {
  return [
    {
      school: "南京航空航天大学",
      city: "南京",
      program: "085400 电子信息",
      college: "物理学院",
      degreeType: "专硕",
      exam: "英一 数二 普物811",
      tags: ["光电", "电子信息", "应用导向", "江苏"],
      difficulty: 74,
      experience: "工科导向强，平台和城市资源较好，适合偏应用与就业。",
      employment: "长三角电子、光电、仪器类岗位适配较强。",
      sourceType: "official",
      sourceUrl: "https://www.graduate.nuaa.edu.cn/jzml_13495/list.htm",
      verifiedYear: 2026,
      confidence: "medium",
      evidenceNote: "基于学校 2026 招生简章及目录入口核验，具体方向字段应以目录正文/附件为准。",
    },
    {
      school: "南京航空航天大学",
      city: "南京",
      program: "080300 光学工程",
      college: "航天学院",
      degreeType: "学硕",
      exam: "英一 数一 普物811",
      tags: ["光学工程", "学硕", "江苏"],
      difficulty: 79,
      experience: "数一门槛更高，但研究平台更偏学术和工程结合。",
      employment: "适合继续做光学、成像、检测、研发类岗位。",
      sourceType: "official",
      sourceUrl: "https://www.graduate.nuaa.edu.cn/jzml_13495/list.htm",
      verifiedYear: 2026,
      confidence: "medium",
      evidenceNote: "以南航研究生院专业目录页为核验入口，具体招生方向应以当年专业目录为准。",
    },
    {
      school: "南京理工大学",
      city: "南京",
      program: "085408 光电信息工程",
      college: "电子工程与光电技术学院",
      degreeType: "专硕",
      exam: "英二 数二 光学工程819",
      tags: ["光电", "专硕", "江苏"],
      difficulty: 76,
      experience: "专业对口度高，工程和就业导向明确。",
      employment: "在南京和长三角光电产业链中辨识度较强。",
      sourceType: "official",
      sourceUrl: "https://gs.njust.edu.cn/zsw/6b/27/c4587a355111/page.htm",
      verifiedYear: 2026,
      confidence: "high",
      evidenceNote: "南京理工大学 2026 硕士招生简章及目录入口已核验。",
    },
    {
      school: "苏州大学",
      city: "苏州",
      program: "070200 物理学",
      college: "物理科学与技术学院",
      degreeType: "学硕",
      exam: "英一 数学 普物",
      tags: ["物理学", "学硕", "江苏"],
      difficulty: 72,
      experience: "更适合想保留物理学术延展性的学生。",
      employment: "继续深造空间较好，就业更看具体方向和个人能力。",
      sourceType: "official",
      sourceUrl: "https://yjs.suda.edu.cn/54/32/c8386a676914/page.htm",
      verifiedYear: 2026,
      confidence: "high",
      evidenceNote: "苏州大学 2026 硕士研究生招生专业目录已核验。",
    },
    {
      school: "苏州大学",
      city: "苏州",
      program: "080300 光学工程",
      college: "光电科学与工程学院",
      degreeType: "学硕",
      exam: "英一 数一 应用光学841",
      tags: ["光学工程", "学硕", "江苏"],
      difficulty: 75,
      experience: "从物理跨到光学工程的过渡较自然。",
      employment: "光学检测、成像、器件方向较有承接。",
      sourceType: "official",
      sourceUrl: "https://yjs.suda.edu.cn/54/32/c8386a676914/page.htm",
      verifiedYear: 2026,
      confidence: "high",
      evidenceNote: "苏州大学 2026 硕士研究生招生专业目录已核验。",
    },
    {
      school: "中南大学",
      city: "长沙",
      program: "085400 光电信息工程",
      college: "物理学院",
      degreeType: "专硕",
      exam: "英二 数二 量子力学809",
      tags: ["光电", "专硕", "中部"],
      difficulty: 68,
      experience: "量子力学科目会拉开与工科常规光电项目的差异。",
      employment: "综合平台强，适合愿意去中部发展的学生。",
      sourceType: "secondary",
      sourceUrl: "https://m.koolearn.com/kaoyan/20251011/1883998.html",
      verifiedYear: 2026,
      confidence: "medium",
      evidenceNote: "专业方向与考试科目来自公开整理页，学校官方简章页已核验存在但该方向细项建议复查学院目录。",
    },
    {
      school: "西南交通大学",
      city: "成都",
      program: "070200 物理学",
      college: "物理学院",
      degreeType: "学硕",
      exam: "英一 数一 普物867",
      tags: ["物理学", "学硕", "西南"],
      difficulty: 70,
      experience: "物理本专业延续性强，招生规模相对友好。",
      employment: "适合继续科研或转向教师、研发类路径。",
      sourceType: "official",
      sourceUrl: "https://yz.swjtu.edu.cn/vatuu/PlanMasterMajorAction?setAction=intro&type=zszyml",
      verifiedYear: 2026,
      confidence: "medium",
      evidenceNote: "西南交大 2026 硕士招生专业目录入口已核验，具体条目以目录检索结果为准。",
    },
    {
      school: "四川大学",
      city: "成都",
      program: "080300 光学工程",
      college: "电子信息学院",
      degreeType: "学硕",
      exam: "英一 数一 普物853",
      tags: ["光学工程", "学硕", "985"],
      difficulty: 85,
      experience: "平台强，但竞争和考试门槛更高。",
      employment: "平台、地域和品牌优势明显。",
      sourceType: "official",
      sourceUrl: "https://yz.scu.edu.cn/zsxx/Details/24514aab-5ae2-4ca9-b4b2-1bea9b38f77c",
      verifiedYear: 2026,
      confidence: "medium",
      evidenceNote: "四川大学 2026 硕士招生章程已核验，具体学院专业字段应以专业目录为准。",
    },
    {
      school: "电子科技大学",
      city: "成都",
      program: "085400 电子信息",
      college: "光电科学与工程学院",
      degreeType: "专硕",
      exam: "英二 数二",
      tags: ["电子信息", "光电", "985", "专硕"],
      difficulty: 84,
      experience: "偏产业和平台资源，适合就业导向明确的学生。",
      employment: "电子与光电行业出口强。",
      sourceType: "secondary",
      sourceUrl: "https://kaoyan.xdf.cn/202511/14995680.html",
      verifiedYear: 2026,
      confidence: "medium",
      evidenceNote: "电子科大光电科学与工程学院专业与拟招生人数来自公开整理页，正式报考前应复核官方目录。",
    },
    {
      school: "中国计量大学",
      city: "杭州",
      program: "085407 仪器仪表工程",
      college: "光学与电子科技学院",
      degreeType: "专硕",
      exam: "英二 数二",
      tags: ["仪器", "专硕", "长三角"],
      difficulty: 64,
      experience: "更偏稳妥和应用，适合求稳并看重城市的学生。",
      employment: "检测、测量、仪器、制造业质量岗位较匹配。",
      sourceType: "secondary",
      sourceUrl: "https://yzb.cjlu.edu.cn/",
      verifiedYear: 2026,
      confidence: "low",
      evidenceNote: "需在正式报考前复核学校当年硕士专业目录；当前作为辅助备选信息保留。",
    },
    {
      school: "南京信息工程大学",
      city: "南京",
      program: "085408 光电信息工程",
      college: "电子与信息工程学院",
      degreeType: "专硕",
      exam: "英二 数二",
      tags: ["光电", "专硕", "江苏", "保底"],
      difficulty: 60,
      experience: "作为江苏本地的保底梯队更有意义。",
      employment: "区域就业承接尚可，适合以留江苏为先的学生。",
      sourceType: "official",
      sourceUrl: "https://wdy.nuist.edu.cn/6798/listm.htm",
      verifiedYear: 2026,
      confidence: "high",
      evidenceNote: "南京信息工程大学物理与光电工程学院 2026 招生目录已逐条核验。",
    },
    {
      school: "南京信息工程大学",
      city: "南京",
      program: "080300 光学工程",
      college: "物理与光电工程学院",
      degreeType: "学硕",
      exam: "英一 数一 820普通物理学（光学）",
      tags: ["光学工程", "学硕", "江苏"],
      difficulty: 66,
      experience: "本校目录透明，考试科目明确，适合作为学硕保底或匹配下沿。",
      employment: "可延伸到光电检测、传感、器件与继续深造。",
      sourceType: "official",
      sourceUrl: "https://wdy.nuist.edu.cn/6798/listm.htm",
      verifiedYear: 2026,
      confidence: "high",
      evidenceNote: "南京信息工程大学物理与光电工程学院 2026 招生目录已逐条核验。",
    },
  ];
}

function scoreCandidates(profile, programs) {
  return programs
    .map((item) => {
      let score = 60;
      const hasInterestPreference = profile.interest.length > 0;
      const interestMatched = hasInterestPreference
        ? profile.interest.some((interest) => item.tags.some((tag) => tag.includes(interest) || interest.includes(tag)))
        : false;
      const wantsJiangsu = profile.locations.includes("江苏");
      const strongJiangsuPreference = wantsJiangsu && profile.constraints.some((item) => /留在江苏|尽量留江苏|最好留江苏/.test(item));
      const isJiangsuProgram = /南京|苏州/.test(item.city);
      const theoryHeavyExam = /量子力学|普物/.test(item.exam);
      const avoidsPurePhysics = profile.constraints.some((item) => /不想纯物理|不太想纯物理|不考虑纯物理/.test(item));
      const sameSchool = item.school === profile.school;

      if (wantsJiangsu && isJiangsuProgram) score += 10;
      if (wantsJiangsu && !isJiangsuProgram) score -= strongJiangsuPreference ? 12 : 4;
      if (profile.locations.includes("成都") && item.city === "成都") score += 6;
      if (profile.degreePreference === "学硕优先" && item.degreeType === "学硕") score += 8;
      if (profile.degreePreference === "专硕优先" && item.degreeType === "专硕") score += 8;
      if (profile.degreePreference === "专硕优先" && item.degreeType === "学硕") score -= 6;
      if (profile.degreePreference === "学硕优先" && item.degreeType === "专硕") score -= 6;
      if (profile.degreePreference === "都可以") score += 4;
      if (interestMatched) score += 12;
      if (hasInterestPreference && !interestMatched) score -= 12;
      if (profile.careerPreference === "就业优先" && item.tags.includes("专硕")) score += 8;
      if (profile.careerPreference === "就业优先" && item.degreeType === "学硕") score -= 4;
      if (profile.careerPreference === "就业优先" && theoryHeavyExam) score -= 6;
      if (profile.careerPreference === "就业优先，保留读博可能" && item.tags.includes("专硕")) score += 5;
      if (profile.careerPreference === "就业优先，保留读博可能" && item.degreeType === "学硕") score += 1;
      if (profile.careerPreference === "科研/读博优先" && item.degreeType === "学硕") score += 8;
      if (profile.careerPreference === "科研/读博优先" && theoryHeavyExam) score += 4;
      if (profile.riskTolerance === "求稳" && item.difficulty <= 70) score += 10;
      if (profile.riskTolerance === "愿意冲" && item.difficulty >= 78) score += 8;
      if (avoidsPurePhysics && item.tags.includes("物理学")) score -= 18;
      if (sameSchool) score -= 10;
      if (profile.mathLevel.includes("数一")) {
        if (item.exam.includes("数一")) score += 6;
      } else if (profile.mathLevel) {
        if (item.exam.includes("数一")) score -= 6;
      }
      if (profile.mathLevel.includes("数学偏弱") && theoryHeavyExam) score -= 6;
      if (profile.mathLevel.includes("对数一有顾虑") && item.exam.includes("数一")) score -= 6;
      if (item.confidence === "high") score += 3;
      if (item.confidence === "low") score -= 6;

      return {
        ...item,
        score,
        difficultyTag: item.difficulty >= 82 ? "高" : item.difficulty >= 72 ? "中高" : item.difficulty >= 64 ? "中" : "中低",
      };
    })
    .sort((a, b) => b.score - a.score);
}

function buildRecommendations(candidates) {
  const qualifiedCandidates = candidates.filter((item) => item.score >= 68);
  return {
    sprint: qualifiedCandidates
      .filter((item) => item.difficulty >= 80)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2),
    match: qualifiedCandidates
      .filter((item) => item.difficulty >= 68 && item.difficulty < 80)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3),
    safe: qualifiedCandidates
      .filter((item) => item.difficulty < 68 && item.score >= 72)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3),
  };
}

function queueResearchFromMessage(session, message) {
  if (!hasResearchIntent(message)) return [];

  const requests = extractResearchRequests(message);
  if (!requests.length) return [];

  const queued = [];

  for (const request of requests.slice(0, 2)) {
    const key = `${request.school}__${request.programKeyword}`;
    const exists = knowledgeBase.some((item) => item.school === request.school && item.program.includes(request.programKeyword));

    if (exists || researchInFlight.has(key)) continue;

    researchInFlight.add(key);
    const queuedItem = {
      school: request.school,
      program: request.programKeyword,
      status: "queued",
      message: "已启动后台联网核验，当前回复不会等待检索完成。",
    };
    queued.push(queuedItem);
    void researchProgramAndUpdateKnowledgeBase({
      school: request.school,
      program: request.programKeyword,
    })
      .then((result) => {
        refreshCaseWorkspace(session, {
          latestUserMessage: "",
          researchUpdates: [result],
        });
        persistSession(session);
      })
      .catch((error) => {
        console.error("Background research failed:", request.school, request.programKeyword, error);
        refreshCaseWorkspace(session, {
          latestUserMessage: "",
          researchUpdates: [
            {
              school: request.school,
              program: request.programKeyword,
              status: "error",
              message: error.message || "Research failed",
            },
          ],
        });
        persistSession(session);
      })
      .finally(() => {
        researchInFlight.delete(key);
      });
  }

  return queued;
}

function hasResearchIntent(message) {
  return /查|查询|检索|搜一下|了解一下|看看|纳入考虑|加入考虑|放进考虑|补录|更新知识库|加进来|也考虑/.test(message);
}

function extractResearchRequests(message) {
  const schoolMatches = [...message.matchAll(/([\u4e00-\u9fa5]{2,20}?(?:大学|学院))/g)].map((match) => ({
    school: cleanSchoolName(match[1]),
    index: match.index || 0,
  }));
  const programKeywords = ["光电信息工程", "仪器仪表工程", "光学工程", "电子信息", "物理学", "光电"];
  const programMatches = [];

  for (const keyword of programKeywords) {
    for (const match of message.matchAll(new RegExp(keyword, "g"))) {
      programMatches.push({ programKeyword: keyword, index: match.index || 0 });
    }
  }

  schoolMatches.sort((a, b) => a.index - b.index);
  programMatches.sort((a, b) => a.index - b.index);

  if (!schoolMatches.length || !programMatches.length) {
    return [];
  }

  const requests = [];

  for (let i = 0; i < schoolMatches.length; i += 1) {
    const currentSchool = schoolMatches[i];
    const nextSchoolIndex = schoolMatches[i + 1]?.index ?? Number.POSITIVE_INFINITY;
    const candidateProgram =
      programMatches.find((item) => item.index > currentSchool.index && item.index < nextSchoolIndex) ||
      programMatches.find((item) => item.index >= currentSchool.index);

    if (currentSchool.school && candidateProgram?.programKeyword) {
      requests.push({
        school: currentSchool.school,
        programKeyword: candidateProgram.programKeyword,
      });
    }
  }

  return requests;
}

function cleanSchoolName(value) {
  const cleaned = value
    .replace(/^(我也想把|我想把|想把|把|看看|考虑|还有|以及|和)/, "")
    .replace(/(放进考虑里|放进考虑|也纳入考虑|纳入考虑)$/, "")
    .trim();

  const splitByConjunction = cleaned.split(/[和及、，,\s]+/).filter(Boolean);
  const tailCandidate = splitByConjunction[splitByConjunction.length - 1] || cleaned;
  const tailMatch = tailCandidate.match(/([\u4e00-\u9fa5]{2,20}(?:大学|学院))$/);
  return tailMatch ? tailMatch[1] : tailCandidate;
}

function isValidSchoolName(value) {
  return /^[\u4e00-\u9fa5]{2,20}(?:大学|学院)$/.test(value) && !/(我也想把|物理学和|光学工程和)/.test(value);
}

async function researchProgramAndUpdateKnowledgeBase({ school, program }) {
  const query = `${school} ${program} 硕士 研究生 招生 专业目录`;
  const searchResults = await searchWeb(query);
  const rankedResults = rankSearchResults(searchResults, school, program);

  if (!rankedResults.length) {
    return {
      school,
      program,
      status: "not_found",
      message: "未检索到可用来源",
    };
  }

  const best = rankedResults[0];
  const page = await fetchPageSummary(best.url);
  const record = buildResearchedRecord({ school, program, best, page });
  if (!isKnowledgeRecordUsable(record)) {
    return {
      school,
      program,
      status: "not_found",
      message: "检索到的页面可信度不足，已跳过自动入库",
    };
  }
  const merged = mergeKnowledgeRecord(record);

  return {
    school,
    program,
    status: "updated",
    record: merged,
  };
}

async function searchWeb(query) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetchWithTimeout(url, webSearchTimeoutMs, {
    headers: {
      "User-Agent": "Mozilla/5.0",
    },
  });

  if (!response.ok) {
    throw new Error(`Search failed: ${response.status}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);
  const results = [];

  $(".result").each((_index, element) => {
    const link = $(element).find(".result__a").first();
    const title = link.text().trim();
    const href = link.attr("href");
    const snippet = $(element).find(".result__snippet").text().trim();

    if (title && href) {
      results.push({
        title,
        url: normalizeSearchResultUrl(href),
        snippet,
      });
    }
  });

  return results;
}

function normalizeSearchResultUrl(url) {
  try {
    const parsed = url.startsWith("//") ? new URL(`https:${url}`) : new URL(url);
    const uddg = parsed.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : url;
  } catch {
    return url;
  }
}

function rankSearchResults(results, school, program) {
  return results
    .map((item) => {
      let score = 0;
      if (item.title.includes(school) || item.snippet.includes(school)) score += 20;
      if (item.title.includes(program) || item.snippet.includes(program)) score += 18;
      if (/研究生|招生|专业目录|简章/.test(item.title + item.snippet)) score += 10;
      if (isOfficialDomain(item.url)) score += 25;
      if (/m\.koolearn|xdf|kaoyan/.test(item.url)) score -= 5;
      if (isAffiliatedCollegeText(`${item.title} ${item.snippet}`)) score -= 35;
      if (extractYear(`${item.title} ${item.snippet}`) && extractYear(`${item.title} ${item.snippet}`) < new Date().getFullYear() - 1) score -= 25;

      return { ...item, score };
    })
    .filter((item) => item.score >= 20)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

function isOfficialDomain(url) {
  try {
    const { hostname } = new URL(url);
    return /\.edu\.cn$/.test(hostname) || /\.ac\.cn$/.test(hostname);
  } catch {
    return false;
  }
}

async function fetchPageSummary(url) {
  const response = await fetchWithTimeout(url, webFetchTimeoutMs, {
    headers: {
      "User-Agent": "Mozilla/5.0",
    },
  });

  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);
  const title = $("title").text().trim();
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  return {
    title,
    excerpt: bodyText.slice(0, 1200),
  };
}

function buildResearchedRecord({ school, program, best, page }) {
  const nowYear = new Date().getFullYear();
  const titleText = `${best.title} ${page.title} ${best.snippet} ${page.excerpt}`;
  const verifiedYear = extractYear(titleText) || nowYear;
  const detectedDegreeType = /专业学位|专硕|0854|085407|085408|085400/.test(titleText) ? "专硕" : "学硕";
  const detectedProgram = detectProgramName(program, titleText);
  const detectedCity = detectCity(titleText, school);
  const detectedCollege = detectCollege(titleText);
  const detectedExam = detectExamSubjects(titleText);

  return {
    school,
    city: detectedCity,
    program: detectedProgram,
    college: detectedCollege,
    degreeType: detectedDegreeType,
    exam: detectedExam,
    tags: buildTagsFromProgram(detectedProgram, detectedDegreeType, detectedCity),
    difficulty: 70,
    experience: "该项目为最新联网检索补录，体验类结论需继续结合导师、复试细则和往届反馈完善。",
    employment: "就业导向需进一步结合学院平台和城市产业情况补充。",
    sourceType: isOfficialDomain(best.url) ? "official" : "secondary",
    sourceUrl: best.url,
    verifiedYear,
    confidence: inferResearchConfidence({ sourceUrl: best.url, titleText, verifiedYear, detectedProgram, requestedProgram: program }),
    evidenceNote: `由系统根据检索结果自动补录，来源标题：${best.title}`,
  };
}

function mergeKnowledgeRecord(record) {
  const index = knowledgeBase.findIndex(
    (item) => item.school === record.school && item.program === record.program,
  );

  if (index >= 0) {
    const current = knowledgeBase[index];
    const preferNew =
      (record.verifiedYear || 0) > (current.verifiedYear || 0) ||
      (record.sourceType === "official" && current.sourceType !== "official");

    knowledgeBase[index] = preferNew ? { ...current, ...record } : current;
  } else {
    knowledgeBase.push(record);
  }

  persistKnowledgeBase();
  return knowledgeBase[index >= 0 ? index : knowledgeBase.length - 1];
}

function detectProgramName(programKeyword, text) {
  const knownPrograms = ["070200 物理学", "080300 光学工程", "085408 光电信息工程", "085407 仪器仪表工程", "085400 电子信息"];
  const exact = knownPrograms.find((item) => text.includes(item) || text.includes(item.split(" ")[1]));
  if (exact) return exact;
  if (programKeyword === "光电") return "085408 光电信息工程";
  return /^\d{6}/.test(programKeyword) ? programKeyword : programKeyword;
}

function detectCity(text, school) {
  const pairs = [
    ["南京", "南京"],
    ["苏州", "苏州"],
    ["成都", "成都"],
    ["长沙", "长沙"],
    ["杭州", "杭州"],
  ];
  const matched = pairs.find(([keyword]) => text.includes(keyword));
  if (matched) return matched[1];
  if (school.includes("南京")) return "南京";
  if (school.includes("苏州")) return "苏州";
  if (school.includes("四川") || school.includes("电子科技")) return "成都";
  if (school.includes("中南")) return "长沙";
  if (school.includes("计量")) return "杭州";
  return "待补";
}

function detectCollege(text) {
  const colleges = ["物理学院", "航天学院", "电子工程与光电技术学院", "物理科学与技术学院", "光电科学与工程学院", "电子信息学院", "物理与光电工程学院"];
  return colleges.find((item) => text.includes(item)) || "待补";
}

function detectExamSubjects(text) {
  const parts = [];
  if (/英语[（(]一[）)]|英一|201/.test(text)) parts.push("英一");
  if (/英语[（(]二[）)]|英二|204/.test(text)) parts.push("英二");
  if (/数学[（(]一[）)]|数一|301/.test(text)) parts.push("数一");
  if (/数学[（(]二[）)]|数二|302/.test(text)) parts.push("数二");
  if (/普通物理|普物/.test(text)) parts.push("普物");
  if (/量子力学/.test(text)) parts.push("量子力学");
  if (/信号与系统/.test(text)) parts.push("信号与系统");
  if (/应用光学/.test(text)) parts.push("应用光学");
  return parts.join(" ") || "待补";
}

function buildTagsFromProgram(program, degreeType, city) {
  const tags = [];
  if (/物理学/.test(program)) tags.push("物理学");
  if (/光学工程/.test(program)) tags.push("光学工程");
  if (/光电信息工程|光电/.test(program)) tags.push("光电");
  if (/电子信息/.test(program)) tags.push("电子信息");
  if (/仪器仪表工程/.test(program)) tags.push("仪器");
  if (degreeType) tags.push(degreeType);
  if (city === "南京" || city === "苏州") tags.push("江苏");
  return [...new Set(tags)];
}

function extractYear(text) {
  const match = text.match(/20\d{2}/);
  return match ? Number(match[0]) : null;
}

function extractNumberChunk(text, pattern) {
  const match = text.match(pattern);
  return match?.[2] || "";
}

function extractRanking(text) {
  const percentageMatch = text.match(/前\s*(\d+)\s*%/);
  if (percentageMatch) return `前${percentageMatch[1]}%`;
  const chineseMatch = text.match(/前百分之(\d+)/);
  if (chineseMatch) return `前${chineseMatch[1]}%`;
  const rankingMatch = text.match(/排名[^\d]*(\d+)/);
  if (rankingMatch) return `排名${rankingMatch[1]}`;
  return "";
}

function summarizeEnglish(text) {
  if (/英语.*不错|英语不错|英语较强|英语还可以/.test(text)) return "英语较强";
  if (/六级.*5\d{2}|cet.*5\d{2}/i.test(text)) return "英语较强";
  if (/四级|六级/.test(text)) return "英语有基础";
  if (/英语一般|英语弱/.test(text)) return "英语偏弱";
  return "英语待细化";
}

function summarizeMath(text) {
  if (/数一.*犹豫|犹豫.*数一|不想考数一|不想碰数一|怕数一|数一压力大/.test(text)) return "更适合数二/对数一有顾虑";
  if (/高数不错|数学不错|数学强|数学还可以|数学都不错/.test(text)) return "可承受数一/数学较强";
  if (/数二|数学一般/.test(text)) return "更适合数二/数学一般";
  if (/数学弱|数学偏弱|高数差/.test(text)) return "数学偏弱";
  return "数学待细化";
}

function extractLocations(text) {
  const mapping = ["江苏", "南京", "苏州", "上海", "杭州", "成都", "四川", "湖南", "长沙", "外地"];
  return mapping
    .filter((item) => text.includes(item))
    .map((item) => (item === "南京" || item === "苏州" ? "江苏" : item === "四川" ? "成都" : item));
}

function extractInterests(text) {
  const mapping = ["物理学", "光学工程", "光电", "电子信息", "仪器", "半导体", "师范"];
  return mapping.filter((item) => text.includes(item));
}

function extractDegreePreference(text) {
  if (/还不确定学硕专硕|还没想好学硕专硕|学硕专硕还没想好|学硕专硕暂时不确定/.test(text)) return "";
  if (/学硕专硕都可以|学硕专硕都能接受|学硕专硕都行/.test(text)) return "都可以";
  if (text.includes("都可以")) return "都可以";
  if (/不排斥专硕|能接受专硕|专硕也可以/.test(text)) return "都可以";
  if (/不排斥学硕|学硕也可以/.test(text)) return "都可以";
  if (text.includes("学硕")) return "学硕优先";
  if (text.includes("专硕")) return "专硕优先";
  return "";
}

function extractCareerPreference(text) {
  if ((/就业|工作|薪资/.test(text)) && (/读博|科研/.test(text))) return "就业优先，保留读博可能";
  if (/读博|科研/.test(text)) return "科研/读博优先";
  if (/就业|工作|薪资/.test(text)) return "就业优先";
  if (/城市|生活/.test(text)) return "城市体验优先";
  return "";
}

function extractRiskTolerance(text) {
  if (/稳|保守|不想太难|求稳|上岸优先|更看重上岸|稳妥/.test(text)) return "求稳";
  if (/冲|想拼|可以难一点/.test(text)) return "愿意冲";
  return "";
}

function truncate(text, maxLength) {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function dedupe(values) {
  return [...new Set(values.filter(Boolean))];
}

function isKnowledgeRecordUsable(record) {
  const nowYear = new Date().getFullYear();
  const combined = `${record.school || ""} ${record.program || ""} ${record.college || ""} ${record.evidenceNote || ""} ${record.sourceUrl || ""}`;

  if (!record.school || !record.program) return false;
  if (isAffiliatedCollegeText(combined)) return false;
  if ((record.verifiedYear || 0) < nowYear - 1 && record.sourceType !== "official") return false;
  if ((record.verifiedYear || 0) < nowYear - 3) return false;
  if (record.sourceType === "secondary" && record.confidence === "low") return false;

  return true;
}

function isAffiliatedCollegeText(text) {
  return /科学技术学院|独立学院|继续教育|成人教育|网络教育/.test(text);
}

function inferResearchConfidence({ sourceUrl, titleText, verifiedYear, detectedProgram, requestedProgram }) {
  const nowYear = new Date().getFullYear();
  let score = 0;
  if (isOfficialDomain(sourceUrl)) score += 2;
  if (verifiedYear >= nowYear - 1) score += 2;
  if (titleText.includes(requestedProgram) || detectedProgram.includes(requestedProgram)) score += 1;
  if (!isAffiliatedCollegeText(titleText)) score += 1;

  if (score >= 5) return "high";
  if (score >= 3) return "medium";
  return "low";
}

async function fetchWithTimeout(url, timeoutMs, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
