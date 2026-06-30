# 🤖 Telegram Private Chatbot (v5.4)

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jikssha/telegram_private_chatbot)
![GitHub stars](https://img.shields.io/github/stars/jikssha/telegram_private_chatbot?style=social)
![License](https://img.shields.io/badge/License-MIT-blue.svg)
[![Telegram](https://img.shields.io/badge/Telegram-DM-blue?style=social&logo=telegram)](https://t.me/vaghr_wegram_bot)
[🇺🇸 English](README_EN.md) | [🇨🇳 简体中文](README.md)

**Telegram Private Chatbot** 是一个基于 **Cloudflare Workers** 的高性能 Telegram 双向私聊机器人。它专为解决 Telegram 上的垃圾广告骚扰而生，拥有 **Cloudflare Turnstile 人机验证**、**智能内容过滤系统**、强大的管理员指令集以及无缝的消息转发体验。

无需购买服务器，利用 Cloudflare 强大的边缘计算网络，即可免费部署一套企业级的客户服务系统。

---

<details>
<summary>📢 <b>v5.4 版本重要更新公告 (2026-06-21)</b></summary>

### 新增功能：
- **☁️ Cloudflare Turnstile 人机验证**：支持 Turnstile 点击验证，比传统答题更难被绕过，完全免费（每月 100 万次）。配置 `TURNSTILE_SITE_KEY`、`TURNSTILE_SECRET_KEY`、`VERIFICATION_PAGE_URL` 三个环境变量即可启用。
- **🔍 智能垃圾内容过滤**：支持关键词检测（`SPAM_KEYWORDS` 环境变量）、链接拦截（新用户 24 小时内禁止发链接）、重复消息熔断（相同内容 3 次自动拦截）。
- **🛡️ 骚扰消息通知**：检测到疑似骚扰消息时自动通知管理员群组，支持静默丢弃模式（`SPAM_SILENCE_MODE`）。
- **📄 内置验证页面**：Turnstile 验证页面直接内嵌在 Worker 中，无需额外部署 Pages 项目。
- **📋 `/help` 指令**：快速查看所有可用指令。
- **🔤 屏蔽词管理系统**：支持硬编码 + KV 动态词库，可通过 `/addword`、`/delword`、`/listwords` 指令实时管理。

### 改进：
- Turnstile 未配置时自动降级为本地题库
- 垃圾检测双重执行，防止并发绕过
- 验证通过后自动删除按钮消息
- 验证成功提示重新设计
- `/info` 可点击跳转私聊（手机端）
- 所有指令支持 `@botname` 后缀（如 `/listwords@your_bot`）

### 环境变量（可选）：
| 变量 | 用途 |
|------|------|
| `TURNSTILE_SITE_KEY` | Turnstile Site Key |
| `TURNSTILE_SECRET_KEY` | Turnstile Secret Key |
| `VERIFICATION_PAGE_URL` | Worker URL |
| `SPAM_KEYWORDS` | 垃圾关键词（逗号分隔） |
| `SPAM_SILENCE_MODE` | `true` 启用静默模式 |

</details>

---

## 📑 目录 (Table of Contents)

* [✨ 核心特性](#-核心特性)
* [🛠️ 管理员指令](#-管理员指令)
* [🚀 部署教程](#-部署教程)
    * [方法一：GitHub 一键连接 (推荐)](#方法一github-一键连接部署-推荐-)
    * [方法二：手动复制部署](#方法二手动复制部署-简单直接)
    * [最后一步：激活 Webhook](#最后一步激活-webhook-至关重要)
* [⚙️ 环境变量配置](#️-环境变量配置)
* [❓ 常见问题 (FAQ)](#-常见问题-faq)
* [📈 Star History](#-star-history)

---

## ✨ 核心特性

| 特性 | 描述 |
| :--- | :--- |
| **🔐 Turnstile 验证** | 支持 **Cloudflare Turnstile** 人机验证，自动降级为**本地精选常识题库**。秒开秒验，彻底告别网络超时与接口报错。 |
| **🛡️ 智能防骚扰** | **关键词过滤** + **链接拦截** + **重复消息熔断**，三重防护。验证通过后提供 **30 天免打扰期**。 |
| **💬 话题群组管理** | 利用 **Telegram Forum Topics** 功能，自动为每位私聊用户创建一个独立的话题，消息隔离，管理井井有井。 |
| **👮 隐形指令系统** | 自动**拦截**用户端发送的 `/` 开头指令，防止普通用户骚扰管理员。管理指令仅在管理员群组内生效。 |
| **🔒 权限控制** | 强大的指令集：支持 **封禁 (/ban)**、**解封 (/unban)**、**结单 (/close)** 和 **永久信任 (/trust)** 等操作。 |
| **📝 屏蔽词管理** | 支持**硬编码 + KV 动态词库**，可通过指令实时添加/删除屏蔽词，无需重启。 |
| **☁️ Serverless** | 完全基于 Cloudflare Workers 运行。**0 成本**、无需服务器、无需运维、抗高并发。 |
| **📸 多媒体支持** | 完美支持文本、图片、视频、文件等多种消息格式的双向转发，不丢失任何细节。 |

---

## 🛠️ 管理员指令

> **注意**：以下指令仅在 **管理员群组的话题内** 有效。用户在私聊窗口发送指令会被静蔽拦截，不会对管理员造成骚扰。所有指令都支持 `@botname` 后缀（如 `/listwords@your_bot`）。

### 基础对话管理

| 指令 | 作用 | 适用场景 |
| :--- | :--- | :--- |
| `/close` | **强制关闭对话**<br>机器人会提示用户对话已结束，并拒收新消息。 | 工单处理完成，礼貌结束咨询。 |
| `/open` | **重新开启对话**<br>恢复对该用户的消息转发。 | 误操作关闭，或用户需再次联系。 |

### 用户权限管理

| 指令 | 作用 | 适用场景 |
| :--- | :--- | :--- |
| `/ban` | **封禁用户**<br>机器人将完全无视该用户的所有消息（无提示）。 | 遇到恶意刷屏、广告机器人。 |
| `/unban` | **解封用户**<br>恢复该用户的正常通讯权限。 | 给予改过自新的机会。 |
| `/trust` | **永久信任**<br>该用户将永久免除人机验证（永不过期）。 | 熟人、VIP 客户、长期合作伙伴。 |
| `/reset` | **重置验证**<br>强制清除该用户的验证状态，下次需重新验证。 | 测试验证流程，或怀疑账号被盗。 |

### 信息查询

| 指令 | 作用 | 适用场景 |
| :--- | :--- | :--- |
| `/info` | **查看信息**<br>显示当前用户的 UID、话题 ID 和链接。 | 查询用户资料。 |
| `/help` | **帮助信息**<br>显示所有可用指令列表。 | 快速查阅指令。 |

### 系统维护

| 指令 | 作用 | 适用场景 |
| :--- | :--- | :--- |
| `/cleanup` | **批量清理**<br>扫描并清理已删除话题的用户数据。 | 清理失效用户。 |

### 屏蔽词管理

| 指令 | 作用 | 适用场景 |
| :--- | :--- | :--- |
| `/addword 词` | **添加屏蔽词**<br>将指定词汇添加到动态屏蔽词库。 | 实时添加敏感词。 |
| `/delword 词` | **删除屏蔽词**<br>从动态屏蔽词库中移除指定词汇。 | 移除误添加的屏蔽词。 |
| `/listwords` | **查看屏蔽词**<br>显示所有屏蔽词（硬编码 + 动态）。 | 确认当前屏蔽词配置。 |

---

## 🚀 部署教程

### 前置准备
1.  **Telegram Bot**：找 [@BotFather](https://t.me/BotFather) 申请一个机器人，获取 `Token`。
    * *重要设置*：在 BotFather 中关闭 **Group Privacy** (`/mybots` > Settings > Group Privacy > Turn off)。
2.  **管理员群组**：创建一个 Telegram 群组，并**开启话题功能 (Topics)**。
    * 将机器人拉入群组，并设为**管理员**（给予管理话题权限）。
    * 获取群组 ID（通常以 `-100` 开头）。
     ``获取 SUPERGROUP_ID 小技巧：
在 Telegram 桌面端右键群内任意消息，复制消息链接；链接里会有一段 -100xxxxxxxxxx 或 xxxxxxxxxx；若只看到纯数字 xxxxxxxxxx，在前面加上 -100，就是完整的 SUPERGROUP_ID（私密频道/群组同理）。``

### 方法一：GitHub 一键连接部署 (推荐 ★)

这是最简单的自动化部署方式，当您更新 GitHub 仓库时，Cloudflare 会自动重新部署您的 Worker。

1.  **Fork 本仓库** 到您的 GitHub 账户。
2.  登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)。
3.  导航到 **Workers & Pages** -> **Create Application**。
4.  点击 **Connect to Git** 标签页。
5.  授权 Cloudflare 访问您的 GitHub，并选择您刚才 Fork 的 `telegram_private_chatbot` 仓库。
6.  **配置部署设置**：
    * 项目名称：`telegram-private-chatbot` (或任意名称)。
    * 生产分支：通常是 `main` 或 `master`。
    * 其余保持默认，点击 **Save and Deploy**。
7.  **⚠️ 关键步骤：绑定数据库与变量**
    * 部署完成后，进入该 Worker 的 **Settings** -> **Variables** 页面。
    * **绑定 KV 数据库** (必须)：
        * 在 Cloudflare 左侧菜单 **KV** 中创建一个新的 Namespace（例如叫 `TOPIC_MAP`）。
        * 回到 Worker 的 Variables 页面，向下滚动到 **KV Namespace Bindings**。
        * 点击 **Add binding**，变量名填写 `TOPIC_MAP` (必须全大写)，Namespace 选择刚才创建的那个。
    * **添加环境变量**：
        * `BOT_TOKEN`: 你的机器人 Token。
        * `SUPERGROUP_ID`: 你的群组 ID (例如 -100123...)。
8.  **最后一步**：配置完成后，点击页面顶部的 **Deployments** 标签，找到最新的部署记录，点击右侧的 **Retry deployment** (重新部署)，让变量生效。

### 方法二：手动复制部署 (简单直接)

如果您不想关联 GitHub，可以直接复制代码。

1.  登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)。
2.  进入 **Workers & Pages** -> **Create Application** -> **Create Worker** ，选择从`hello world`开始。
3.  命名你的 Worker，点击 **Deploy**。
4.  点击 **Edit code**，将本项目 `worker.js` 的所有代码复制粘贴进去，覆盖原代码。
5.  点击右上角 **Deploy** 保存。
6.  **配置 KV 与变量**：
    * 去 **Settings** -> **Variables**。
    * 添加 KV 绑定：Variable name 填 `TOPIC_MAP`，并绑定一个 KV 数据库。
    * 添加环境变量：`BOT_TOKEN` 和 `SUPERGROUP_ID`。
    * 点击 **Save and Deploy**。

---

### 最后一步：激活 Webhook (至关重要)

无论使用哪种部署方式，最后都需要手动告诉 Telegram 你的 Worker 地址。请在浏览器中**严格按顺序**访问以下 URL：

 **设置新 Webhook**：
    ```
   (https://api.telegram.org/bot)<YOUR_TOKEN>/setWebhook?url=<YOUR_WORKER_URL>
    ```
    *将 `<YOUR_TOKEN>` 替换为机器人 Token，`<YOUR_WORKER_URL>` 替换为 Worker 的完整域名或者你绑定的自定义的域名 (如 `https://xxx.workers.dev`)。*
    
 *举例：https://api.telegram.org/bot1234:HUSH2GW/setWebhook?url=https://1234.workers.dev* `<YOUR_TOKEN>前面的bot别删了`

如果返回 `{"ok":true, "result":true, "description":"Webhook was set"}`，即表示部署成功！

---

## ⚙️ 环境变量配置

### 必需变量

| 变量名 | 说明 | 示例 |
|--------|------|------|
| `BOT_TOKEN` | Telegram Bot Token | `123456789:ABCdefGHIjklMNOpqrsTUVwxyz` |
| `SUPERGROUP_ID` | 管理员群组 ID | `-1001234567890` |

### 可选变量 - Turnstile 验证

| 变量名 | 说明 | 用途 |
|--------|------|------|
| `TURNSTILE_SITE_KEY` | Turnstile Site Key | 启用 Turnstile 人机验证 |
| `TURNSTILE_SECRET_KEY` | Turnstile Secret Key | 验证 Turnstile token |
| `VERIFICATION_PAGE_URL` | Worker 完整 URL | 生成验证页面链接 |

### 可选变量 - 垃圾过滤

| 变量名 | 说明 | 用途 |
|--------|------|------|
| `SPAM_KEYWORDS` | 垃圾关键词（逗号分隔） | 关键词过滤 |
| `SPAM_SILENCE_MODE` | `true` 或 `false` | 静默模式（不通知管理员） |

### 可选变量 - 管理员白名单

| 变量名 | 说明 | 用途 |
|--------|------|------|
| `ADMIN_IDS` | 管理员用户 ID（逗号分隔） | 绕过 Telegram API 检查 |

---

## ❓ 常见问题 (FAQ)

**Q1: 为什么点击验证按钮没有反应？**
A: 请检查 Webhook 是否正确设置。必须确保 Telegram 允许发送 `callback_query` 事件。请务必执行上述"最后一步"中的重置操作。

**Q2: 为什么机器人无法在群里创建话题？**
A: 请确保：1. 群组 ID 正确（-100开头）；2. 群组已开启 Topics 功能；3. 机器人是群管理员且拥有 "Manage Topics" 权限。

**Q3: 为什么人机验证能通过收不到转发的消息？**
A: 请仔细检查所有变量名称和id是否准确，删除webhook再重新激活。
 `(https://api.telegram.org/bot)<YOUR_TOKEN>/deleteWebhook?drop_pending_updates=true` 
  
  如果依然无法正常转发消息，尝试完成所有步骤后，最后再添加bot的管理员权限。
  
**Q4: 为什么webhook设置失败？**
A: 如果你设置了自定义域名不成功，Webhook 改回 workers.dev 域名再尝试。这种情况是你域名解析失败或者网络环境阻断造成的

**Q5: 如何启用 Turnstile 验证？**
A: 在 Cloudflare Turnstile 创建站点获取 Site Key 和 Secret Key，然后在 Worker 环境变量中配置 `TURNSTILE_SITE_KEY`、`TURNSTILE_SECRET_KEY` 和 `VERIFICATION_PAGE_URL`（即 Worker 的 URL）。

**Q6: 如何添加自定义屏蔽词？**
A: 两种方式：
1. **代码方式**：修改 `worker.js` 中的 `BLOCKED_WORDS` 数组，重新部署。
2. **指令方式**：在群组话题内使用 `/addword 屏蔽词` 指令实时添加。

---

## 🔌 API 端点

Worker 暴露以下 HTTP 端点：

| 端点 | 方法 | 说明 |
|------|------|------|
| `/` | GET | 健康检查，返回 `"OK"` |
| `/health` | GET | 健康检查（同 `/`） |
| `/verify` | GET | Turnstile 人机验证页面（HTML），参数：`code`（验证 ID）、`uid`（用户 ID） |
| `/verify-callback` | POST | Turnstile token 验证接口，请求体：`{ token, code, userId }`，响应：`{ success, pendingCount?, error? }` |
| `/` | POST | Telegram Webhook 接收端点，接收 Telegram Update 对象 |

### /verify-callback 响应示例

**成功响应：**
```json
{ "success": true, "pendingCount": 3 }
```

**错误响应：**
```json
{ "success": false, "error": "turnstile_failed" }
```

| 错误码 | 说明 |
|--------|------|
| `missing_params` | 缺少必要参数 |
| `turnstile_failed` | Turnstile token 验证失败 |
| `code_invalid_or_expired` | 验证链接已过期 |
| `server_error` | 服务器内部错误 |

---

## 🔒 安全说明

> [!IMPORTANT]
> 请妥善保管您的 Bot API Token 和 Turnstile Secret Key，不要泄露，这些信息关系到您服务的安全性。

---

## 📈 Star History

[![Star History Chart](https://api.star-history.com/svg?repos=jikssha/telegram_private_chatbot&type=date&legend=top-left)](https://www.star-history.com/#jikssha/telegram_private_chatbot&type=date&legend=top-left)

---
**如果这个项目对你有帮助，请给个 Star ⭐️ 吧！**
