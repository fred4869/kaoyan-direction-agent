# 考研方向规划 Agent

移动端优先的单页 Web 应用，围绕河海大学物理专业学生的考研方向选择设计。

## 功能

- 聊天主界面
- 按阶段解锁的画像、候选、推荐面板
- 服务端代理 DashScope，对前端隐藏密钥
- 全国扩展的种子候选数据与基础推荐逻辑
- 会话状态与结构化画像接口

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
