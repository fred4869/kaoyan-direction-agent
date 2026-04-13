import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT || 3030);
const dashscopeApiKey = process.env.DASHSCOPE_API_KEY || "";
const dashscopeBaseUrl = (process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/+$/, "");
const dashscopeModel = process.env.DASHSCOPE_MODEL || "qwen-max-latest";

const sessions = new Map();
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
    const sessionId = String(req.body.sessionId || createSessionId());
    const userMessage = String(req.body.message || "").trim();

    if (!userMessage) {
      return res.status(400).json({ error: "message is required" });
    }

    const session = getOrCreateSession(sessionId);
    session.messages.push({ role: "user", content: userMessage, timestamp: Date.now() });

    updateSessionFromMessage(session, userMessage);
    maybeUnlockCandidates(session);
    maybeUnlockRecommendations(session);

    const assistantMessage = dashscopeApiKey
      ? await generateDashScopeReply(session, userMessage)
      : generateLocalReply(session, userMessage);

    session.messages.push({ role: "assistant", content: assistantMessage, timestamp: Date.now() });

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

function createSessionId() {
  return `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createSession() {
  return {
    stage: "初始建档",
    flags: {
      profile_ready: false,
      candidates_ready: false,
      recommendation_ready: false,
    },
    panels_available: [],
    messages: [
      {
        role: "assistant",
        content:
          "我们先把你的情况摸清楚。我会像考研规划师一样，先判断你的基础、偏好和约束，再逐步缩小到适合的学校和专业方向。你可以先告诉我：现在大几、绩点或排名、数学和英语基础、更想留江苏还是可以去外地。",
        timestamp: Date.now(),
      },
    ],
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
  };
}

function getOrCreateSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, createSession());
  }

  return sessions.get(sessionId);
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
    messages: session.messages,
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

  if (/大一|大二|大三|大四|研一|毕业/.test(message)) {
    profile.year = (message.match(/大一|大二|大三|大四|研一|毕业/) || [""])[0];
  }
  if (/绩点|gpa/.test(text)) {
    profile.gpa = extractNumberChunk(message, /(绩点|gpa)[^\d]*(\d(?:\.\d+)?)/i) || profile.gpa;
  }
  if (/排名|前\d+%|前百分之/.test(message)) {
    profile.ranking = extractRanking(message) || profile.ranking;
  }
  if (/英语.*六级|六级|cet[-\s]?6|考研英语/.test(text)) {
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
  if (/家里|预算|不想离家|不能|必须|接受不了/.test(message)) {
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

  if (!session.flags.candidates_ready) {
    session.candidatePrograms = scoreCandidates(session.profile, knowledgeBase).slice(0, 8);
    session.flags.candidates_ready = session.candidatePrograms.length > 0;
    if (session.flags.candidates_ready) {
      session.stage = "候选扩展";
      ensurePanel(session, "candidates");
    }
  }
}

function maybeUnlockRecommendations(session) {
  if (!session.flags.candidates_ready) return;

  const profile = session.profile;
  const readySignals = [profile.mathLevel, profile.englishLevel, profile.careerPreference, profile.riskTolerance]
    .filter(Boolean)
    .length;

  if (readySignals < 3) return;

  if (!session.flags.recommendation_ready) {
    session.recommendations = buildRecommendations(session.candidatePrograms);
    session.flags.recommendation_ready = true;
    session.stage = "结论生成";
    ensurePanel(session, "recommendations");
  }
}

function ensurePanel(session, panel) {
  if (!session.panels_available.includes(panel)) {
    session.panels_available.push(panel);
  }
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
        {
          role: "system",
          content: buildSystemPrompt(session),
        },
        ...session.messages.slice(-8).map((item) => ({
          role: item.role,
          content: item.content,
        })),
        {
          role: "user",
          content: userMessage,
        },
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
  return [
    "你是一名专业、严谨、克制的中国考研规划师。",
    "你的任务是帮助一名河海大学物理专业学生，通过自然语言对话逐步确定考研方向。",
    "你必须优先做三件事：识别信息缺口、解释当前判断、提出下一步最关键的问题。",
    "输出风格要求：简洁、具体、像真实顾问，不空泛，不灌鸡汤。",
    "你要综合考虑：考试难度、科目匹配、学校层次、城市、读研体验、就业出口、学硕专硕差异。",
    "当前阶段：" + session.stage,
    "当前画像摘要：\n" + buildProfileSummary(session.profile).join("\n"),
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

function generateLocalReply(session, userMessage) {
  if (!session.flags.profile_ready) {
    return "我先不急着给学校。就你刚才这段信息，我还缺几项会显著影响判断的内容：一是你现在在年级和排名大概处于什么位置；二是数学和英语分别到什么水平；三是你更倾向留江苏还是能接受外地。把这三项补齐后，我就能开始收缩方向。";
  }

  if (session.flags.profile_ready && !session.flags.candidates_ready) {
    return "你的基础画像已经有雏形了。我下一步会把方向缩到物理学、光学工程、光电信息、电子信息这几个相邻赛道里，但在此之前我还想确认一件事：你更看重上岸稳妥，还是更看重毕业后的就业出口？这个选择会直接改变学校梯队。";
  }

  if (session.flags.candidates_ready && !session.flags.recommendation_ready) {
    const top = session.candidatePrograms.slice(0, 3).map((item) => `${item.school}${item.program}`).join("、");
    return `我已经能给出第一批候选了，当前比较贴近你的有 ${top}。但我还不想过早定结论，因为学硕/专硕接受度、数学承受力和就业取向会继续改变排序。你接下来可以直接告诉我：你能不能接受数一，和你是否排斥专硕。`;
  }

  const rec = session.recommendations;
  const topMatch = rec?.match?.[0];
  return `基于目前信息，我已经形成分层建议。你现在最值得优先深挖的是 ${topMatch ? `${topMatch.school}${topMatch.program}` : "匹配档项目"}。如果你愿意，我下一轮可以继续把每个候选拆开讲清楚：考试科目难点、读研体验、就业出口、以及为什么它比另外几个更适合你。`;
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
    },
  ];
}

function scoreCandidates(profile, programs) {
  return programs
    .map((item) => {
      let score = 60;

      if (profile.locations.includes("江苏") && item.city.match(/南京|苏州/)) score += 10;
      if (profile.locations.includes("成都") && item.city === "成都") score += 6;
      if (profile.degreePreference === "学硕优先" && item.degreeType === "学硕") score += 8;
      if (profile.degreePreference === "专硕优先" && item.degreeType === "专硕") score += 8;
      if (profile.degreePreference === "都可以") score += 4;
      if (profile.interest.some((interest) => item.tags.some((tag) => tag.includes(interest) || interest.includes(tag)))) score += 10;
      if (profile.careerPreference === "就业优先" && item.tags.includes("专硕")) score += 8;
      if (profile.careerPreference === "科研/读博优先" && item.degreeType === "学硕") score += 8;
      if (profile.riskTolerance === "求稳" && item.difficulty <= 70) score += 10;
      if (profile.riskTolerance === "愿意冲" && item.difficulty >= 78) score += 8;
      if (profile.mathLevel.includes("数一")) {
        if (item.exam.includes("数一")) score += 6;
      } else if (profile.mathLevel) {
        if (item.exam.includes("数一")) score -= 6;
      }

      return {
        ...item,
        score,
        difficultyTag: item.difficulty >= 82 ? "高" : item.difficulty >= 72 ? "中高" : item.difficulty >= 64 ? "中" : "中低",
      };
    })
    .sort((a, b) => b.score - a.score);
}

function buildRecommendations(candidates) {
  return {
    sprint: candidates.filter((item) => item.difficulty >= 80).slice(0, 2),
    match: candidates.filter((item) => item.difficulty >= 68 && item.difficulty < 80).slice(0, 3),
    safe: candidates.filter((item) => item.difficulty < 68).slice(0, 3),
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
  if (/六级.*5\d{2}|cet.*5\d{2}/i.test(text)) return "英语较强";
  if (/四级|六级/.test(text)) return "英语有基础";
  if (/英语一般|英语弱/.test(text)) return "英语偏弱";
  return "英语待细化";
}

function summarizeMath(text) {
  if (/数一|高数不错|数学强|数学还可以/.test(text)) return "可承受数一/数学较强";
  if (/数二|数学一般/.test(text)) return "更适合数二/数学一般";
  if (/数学弱|高数差/.test(text)) return "数学偏弱";
  return "数学待细化";
}

function extractLocations(text) {
  const mapping = ["江苏", "南京", "苏州", "上海", "杭州", "成都", "四川", "湖南", "长沙", "外地"];
  return mapping.filter((item) => text.includes(item)).map((item) => (item === "南京" || item === "苏州" ? "江苏" : item === "四川" ? "成都" : item));
}

function extractInterests(text) {
  const mapping = ["物理学", "光学工程", "光电", "电子信息", "仪器", "半导体", "师范"];
  return mapping.filter((item) => text.includes(item));
}

function extractDegreePreference(text) {
  if (text.includes("都可以")) return "都可以";
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
  if (/稳|保守|不想太难|求稳/.test(text)) return "求稳";
  if (/冲|想拼|可以难一点/.test(text)) return "愿意冲";
  return "";
}

function dedupe(values) {
  return [...new Set(values.filter(Boolean))];
}
