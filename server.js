import "dotenv/config";
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
const sessionFilePath = path.join(dataDir, `${defaultSessionId}-session.json`);
const maxWindowMessages = 10;
const retainWindowMessages = 6;

const primarySession = loadSession();
const sessionCache = new Map([[defaultSessionId, primarySession]]);
const knowledgeBase = buildKnowledgeBase();

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

app.post("/api/chat", async (req, res) => {
  try {
    const sessionId = String(req.body.sessionId || defaultSessionId);
    const userMessage = String(req.body.message || "").trim();

    if (!userMessage) {
      return res.status(400).json({ error: "message is required" });
    }

    const session = getOrCreateSession(sessionId);
    const userEntry = { role: "user", content: userMessage, timestamp: Date.now() };
    session.conversationLog.push(userEntry);
    session.conversationWindow.push(userEntry);

    updateSessionFromMessage(session, userMessage);
    maybeUnlockCandidates(session);
    maybeUnlockRecommendations(session);
    refreshWorkingMemory(session);

    const assistantMessage = dashscopeApiKey
      ? await generateDashScopeReply(session, userMessage)
      : generateLocalReply(session);

    const assistantEntry = { role: "assistant", content: assistantMessage, timestamp: Date.now() };
    session.conversationLog.push(assistantEntry);
    session.conversationWindow.push(assistantEntry);
    compressConversation(session);
    refreshWorkingMemory(session);
    persistSession(session);

    res.json({
      sessionId,
      reply: assistantMessage,
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

function createSession() {
  const initialMessage = {
    role: "assistant",
    content:
      "我们先把你的情况摸清楚。我会像考研规划师一样，先判断你的基础、偏好和约束，再逐步缩小到适合的学校和专业方向。你可以先告诉我：现在大几、绩点或排名、数学和英语基础、更想留江苏还是可以去外地。",
    timestamp: Date.now(),
  };

  return {
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
    updatedAt: new Date().toISOString(),
  };
}

function getOrCreateSession(sessionId) {
  if (sessionCache.has(sessionId)) {
    return sessionCache.get(sessionId);
  }

  const session = createSession();
  sessionCache.set(sessionId, session);
  return session;
}

function loadSession() {
  ensureDataDir();

  if (!fs.existsSync(sessionFilePath)) {
    const seed = createSession();
    writeSession(seed);
    return seed;
  }

  try {
    const raw = fs.readFileSync(sessionFilePath, "utf8");
    return normalizeSession(JSON.parse(raw));
  } catch {
    const seed = createSession();
    writeSession(seed);
    return seed;
  }
}

function persistSession(session) {
  const normalized = normalizeSession(session);
  if (session === primarySession) {
    writeSession(normalized);
  }
}

function writeSession(session) {
  ensureDataDir();
  session.updatedAt = new Date().toISOString();
  fs.writeFileSync(sessionFilePath, JSON.stringify(session, null, 2), "utf8");
}

function ensureDataDir() {
  fs.mkdirSync(dataDir, { recursive: true });
}

function normalizeSession(session) {
  if (!session || typeof session !== "object") {
    return createSession();
  }

  const normalized = createSession();
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
  refreshWorkingMemory(normalized);
  return normalized;
}

function buildSessionPayload(session) {
  return {
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
  };
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

  if (profileDataPoints >= 6) {
    session.stage = "候选扩展";
  }
}

function maybeUnlockCandidates(session) {
  if (!session.flags.profile_ready) return;

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
  return data.choices?.[0]?.message?.content?.trim() || generateLocalReply(session);
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

function generateLocalReply(session) {
  if (!session.flags.profile_ready) {
    return "我先不急着给学校。就目前信息，我还缺几项会显著影响判断的内容：一是你现在在年级和排名大概处于什么位置；二是数学和英语分别到什么水平；三是你更倾向留江苏还是能接受外地。把这三项补齐后，我就能开始收缩方向。";
  }

  if (session.flags.profile_ready && !session.flags.candidates_ready) {
    return "你的基础画像已经有雏形了。我下一步会把方向缩到物理学、光学工程、光电信息、电子信息这几个相邻赛道里，但在此之前我还想确认一件事：你更看重上岸稳妥，还是更看重毕业后的就业出口？这个选择会直接改变学校梯队。";
  }

  if (session.flags.candidates_ready && !session.flags.recommendation_ready) {
    const top = session.candidatePrograms.slice(0, 3).map((item) => `${item.school}${item.program}`).join("、");
    const missing = session.workingMemory.openQuestions.slice(0, 2).join("、");
    return `我已经能给出第一批候选了，当前比较贴近你的有 ${top}。但我还不想过早定结论，因为还有 ${missing || "几个关键信息"} 没确认，它们会继续改变排序。你下一条直接补这部分，我再把建议收紧。`;
  }

  const topMatch = session.recommendations?.match?.[0];
  const openQuestions = session.workingMemory.openQuestions;

  if (openQuestions.length) {
    return `我已经形成初步分层建议，当前最值得优先深挖的是 ${topMatch ? `${topMatch.school}${topMatch.program}` : "匹配档项目"}。不过还有 ${openQuestions.join("、")} 这些点没完全确认，它们会继续影响排序。你可以任选一个先补充，我再把建议收紧。`;
  }

  return `基于目前信息，我已经形成分层建议。你现在最值得优先深挖的是 ${topMatch ? `${topMatch.school}${topMatch.program}` : "匹配档项目"}。如果你愿意，我下一轮可以继续把每个候选拆开讲清楚：考试科目难点、读研体验、就业出口、以及为什么它比另外几个更适合你。`;
}

function isRecommendationReady(profile) {
  return Boolean(
    profile.year &&
      (profile.gpa || profile.ranking) &&
      profile.mathLevel &&
      profile.englishLevel &&
      profile.locations.length &&
      profile.degreePreference &&
      profile.careerPreference,
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
      if (profile.careerPreference === "科研/读博优先" && item.degreeType === "学硕") score += 8;
      if (profile.careerPreference === "科研/读博优先" && theoryHeavyExam) score += 4;
      if (profile.riskTolerance === "求稳" && item.difficulty <= 70) score += 10;
      if (profile.riskTolerance === "愿意冲" && item.difficulty >= 78) score += 8;
      if (avoidsPurePhysics && item.tags.includes("物理学")) score -= 18;
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
  if (text.includes("都可以")) return "都可以";
  if (/不排斥专硕|能接受专硕|专硕也可以/.test(text)) return "都可以";
  if (/不排斥学硕|学硕也可以/.test(text)) return "都可以";
  if (text.includes("学硕")) return "学硕优先";
  if (text.includes("专硕")) return "专硕优先";
  return "";
}

function extractCareerPreference(text) {
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
