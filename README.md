# 考研方向规划 Agent

移动端优先的单页 Web 应用，围绕河海大学物理专业学生的考研方向选择设计。

## 功能

- 聊天主界面
- 按阶段解锁的画像、候选、推荐面板
- 服务端代理 DashScope，对前端隐藏密钥
- 全国扩展的种子候选数据与基础推荐逻辑
- 会话状态与结构化画像接口
- 单用户本地文件持久化
- 分层记忆与历史压缩

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

未配置 `DASHSCOPE_API_KEY` 时，应用会退回到本地规则引擎，便于界面联调，但不会调用真实大模型。

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
