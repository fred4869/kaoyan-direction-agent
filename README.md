# 考研方向规划 Agent

移动端优先的单页 Web 应用，围绕河海大学物理专业学生的考研方向选择设计。

## 功能

- 聊天主界面
- 按阶段解锁的画像、候选、推荐面板
- 服务端代理 DashScope，对前端隐藏密钥
- LLM 作为主对话逻辑，负责自然语言理解、追问、解释与多轮推进
- 全国扩展的种子候选数据与基础推荐逻辑
- 会话状态与结构化画像接口
- 单用户本地文件持久化
- 分层记忆与历史压缩
- 带来源、年份、可信度的核验知识库
- 新学校/新专业的联网检索与自动入库

## 启动

1. 安装依赖

```bash
npm install
```

2. 配置环境变量

```bash
cp .env.example .env
```

填写 `DASHSCOPE_API_KEY`。

3. 启动

```bash
npm run dev
```

打开 [http://localhost:3030](http://localhost:3030)。

## 接口

- `GET /api/health`
- `POST /api/chat`
- `GET /api/session/:sessionId`

## 说明

默认必须配置 `DASHSCOPE_API_KEY` 才能对话。

如果你只是本地联调界面，可以显式设置：

```bash
ALLOW_RULE_FALLBACK=true
```

这样服务才会退回到本地规则引擎。线上环境不建议开启，否则会表现得像“能聊天”，但实际上没有真正的大语言模型理解能力。

当前架构中：

- LLM 负责主对话、自然语言理解、跟进追问、重总结、候选解释
- 服务端规则负责结构化候选排序、研究队列、证据库、持久化和联网补录
- 没有配置 LLM 时，默认直接报错，不再假装提供正常对话体验

会话和画像会保存到本地文件 [data/primary-session.json](/Users/alfred/codex/kaoyan-agent/data/primary-session.json)。服务重启后仍可继续，适合单用户长期使用。

## 记忆设计

为了避免长期对话后上下文过长、输入混乱，服务端把记忆分成三层：

- `conversationWindow`：最近几轮原始对话，直接给前端展示，也作为模型的短期上下文
- `conversationArchive`：超过窗口长度的历史对话会被压缩成摘要
- `workingMemory`：当前焦点、已确认事实、待确认问题、阶段摘要

每轮对话后，系统会：

1. 更新结构化画像
2. 更新候选与推荐结果
3. 刷新 `workingMemory`
4. 当原始消息过多时，将早期消息压缩到 `conversationArchive`

这样既能长期保存信息，又不会让模型输入无限增长。

## 知识库说明

应用内置的院校项不再是纯演示样例。每条记录都包含：

- `sourceUrl`
- `sourceType`
- `verifiedYear`
- `confidence`
- `evidenceNote`

其中优先使用学校研究生院或学院官方目录页；当只拿到公开整理页时，会明确标记为 `secondary`，并在界面上提示正式报考前复核官方目录。

## 动态检索

当用户把新的学校或专业纳入考虑时，后端支持：

- 联网检索最新招生目录或相关页面
- 优先选择官方域名结果
- 自动生成结构化记录
- 写回本地 [data/knowledge-base.json](/Users/alfred/codex/kaoyan-agent/data/knowledge-base.json)

接口：

- `POST /api/research/program`
- 聊天接口 `POST /api/chat` 也会对新学校/专业尝试自动补录
