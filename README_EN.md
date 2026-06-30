# 🛡️ Telegram Private Chatbot (v5.4)

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jikssha/telegram_private_chatbot)
![GitHub stars](https://img.shields.io/github/stars/jikssha/telegram_private_chatbot?style=social)
![License](https://img.shields.io/badge/License-MIT-blue.svg)
[![Telegram](https://img.shields.io/badge/Telegram-DM-blue?style=social&logo=telegram)](https://t.me/vaghr_wegram_bot)

[🇺🇸 English](README_EN.md) | [🇨🇳 简体中文](README.md)

**Telegram Private Chatbot** is a high-performance, two-way private messaging bot based on **Cloudflare Workers**. It is designed to solve the problem of spam harassment on Telegram, featuring **Cloudflare Turnstile verification**, **smart content filtering**, a powerful set of administrator commands, and a seamless message forwarding experience.

Deploy a free, enterprise-grade customer service system utilizing Cloudflare's powerful edge computing network without purchasing any servers.

---

## 📑 Table of Contents

* [✨ Key Features](#-key-features)
* [🛠️ Administrator Commands](#-administrator-commands)
* [🚀 Deployment Tutorial](#-deployment-tutorial)
    * [Method 1: One-Click Deploy via GitHub (Recommended)](#method-1-one-click-deploy-via-github-recommended-)
    * [Method 2: Manual Deployment](#method-2-manual-deployment-simple--direct)
    * [Final Step: Activate Webhook](#final-step-activate-webhook-crucial)
* [❓ FAQ](#-faq)
* [📈 Star History](#-star-history)

---

## 📝 Changelog (v5.4)

| Date | Changes |
|------|---------|
| 2026-06-30 | Security: Added SSRF protection for `API_BASE` allowlist; Fixed XSS in verification page HTML template |
| 2026-06-30 | Resilience: Added top-level try-catch to `handleAdminReply` and `sendVerificationChallenge` with KV rollback |
| 2026-06-30 | Performance: Eliminated duplicate blocked-words/spam checks; parallelized pending message forwarding |
| 2026-06-30 | Stability: Added TTL eviction for `messageHashCache`; added negative cache for missing thread mappings |
| 2026-06-30 | Infrastructure: Updated `compatibility_date`; fixed KV key extraction in sync script |

---

## ✨ Key Features

| Feature | Description |
| :--- | :--- |
| **🔐 Turnstile Verification** | Supports **Cloudflare Turnstile** verification, auto-degrades to a **local curated trivia database** when not configured. |
| **🛡️ Smart Anti-Spam** | **Keyword filtering** + **link blocking** + **repeat message circuit breaker**, triple protection. Provides a **30-day disturbance-free period** after verification. |
| **💬 Topic Group Management** | Utilizes **Telegram Forum Topics** to automatically create a separate topic for each private chat user, isolating messages for organized management. |
| **👮 Invisible Command System** | Automatically **intercepts** commands starting with `/` sent by users to prevent harassment. Admin commands are only effective within the administrator group. |
| **🔒 Permission Control** | Powerful command set: Supports **Ban (/ban)**, **Unban (/unban)**, **Close Ticket (/close)**, and **Trust (/trust)** operations. |
| **☁️ Serverless** | Runs entirely on Cloudflare Workers. **Zero cost**, server-free, maintenance-free, and handles high concurrency. |
| **📸 Multimedia Support** | Perfectly supports two-way forwarding of text, images, videos, files, and other message formats without losing any details. |

---

## 🛠️ Administrator Commands

> **Note**: The following commands are only effective within **topics in the administrator group**. Commands sent by users in private chats will be silently intercepted and will not disturb administrators.

| Command | Action | Scenario |
| :--- | :--- | :--- |
| `/close` | **Force Close Chat**<br>The bot will notify the user that the chat has ended and reject new messages. | Ticket resolved; politely ending the consultation. |
| `/open` | **Reopen Chat**<br>Resumes message forwarding for the user. | Accidental closure, or the user needs to contact again. |
| `/ban` | **Ban User**<br>The bot will completely ignore all messages from this user (no notification). | Malicious spamming, ad bots. |
| `/unban` | **Unban User**<br>Restores the user's normal communication permissions. | Giving a second chance. |
| `/trust` | **Permanent Trust**<br>The user will be permanently exempt from CAPTCHA verification (never expires). | Acquaintances, VIP clients, long-term partners. |
| `/reset` | **Reset Verification**<br>Forcibly clears the user's verification status; re-verification required next time. | Testing verification flow, or suspected account compromise. |
| `/info` | **View Info**<br>Displays the current user's UID, Topic ID, and profile link. | Checking user details. |
| `/help` | **Help**<br>Displays the full list of available admin commands. | Quick reference. |
| `/addword` | **Add Blocked Word**<br>Adds a word to the dynamic blocked words list (KV). | Blocking new spam keywords. |
| `/delword` | **Remove Blocked Word**<br>Removes a word from the dynamic blocked words list. | Unblocking a word. |
| `/listwords` | **List Blocked Words**<br>Displays all blocked words (hardcoded + dynamic). | Reviewing blocked words. |
| `/cleanup` | **Cleanup Orphaned Data**<br>Scans and cleans up orphaned KV records (deleted topics, expired data). | Maintenance. |

---

## 🚀 Deployment Tutorial

### Prerequisites
1.  **Telegram Bot**: Apply for a bot from [@BotFather](https://t.me/BotFather) and get the `Token`.
    * *Important*: Turn off **Group Privacy** in BotFather (`/mybots` > Settings > Group Privacy > Turn off).
2.  **Administrator Group**: Create a Telegram group and **enable Topics**.
    * Add the bot to the group and set it as an **Administrator** (grant "Manage Topics" permission).
    * Get the Group ID (usually starts with `-100`).
    > **Tip for getting SUPERGROUP_ID**: In Telegram Desktop, right-click any message in the group and copy the message link. The link will contain a segment like `-100xxxxxxxxxx` or `xxxxxxxxxx`. If you only see numbers `xxxxxxxxxx`, add `-100` in front to get the full `SUPERGROUP_ID` (same applies to private channels/groups).

### Method 1: One-Click Deploy via GitHub (Recommended ★)

This is the simplest automated deployment method. Cloudflare will automatically redeploy your Worker when you update your GitHub repository.

1.  **Fork this repository** to your GitHub account.
2.  Log in to the [Cloudflare Dashboard](https://dash.cloudflare.com/).
3.  Navigate to **Workers & Pages** -> **Create Application**.
4.  Click the **Connect to Git** tab.
5.  Authorize Cloudflare to access your GitHub and select the `telegram_private_chatbot` repository you just forked.
6.  **Configure Deployment**:
    * Project Name: `telegram-private-chatbot` (or any name).
    * Production Branch: Usually `main` or `master`.
    * Keep others as default and click **Save and Deploy**.
7.  **⚠️ Crucial Step: Bind Database & Variables**
    * After deployment, go to the **Settings** -> **Variables** page of the Worker.
    * **Bind KV Database** (Required):
        * In the Cloudflare sidebar menu **KV**, create a new Namespace (e.g., named `TOPIC_MAP`).
        * Go back to the Worker's Variables page, scroll down to **KV Namespace Bindings**.
        * Click **Add binding**, set Variable name to `TOPIC_MAP` (must be uppercase), and select the Namespace you just created.
    * **Add Environment Variables**:
        * `BOT_TOKEN`: Your bot token.
        * `SUPERGROUP_ID`: Your group ID (e.g., -100123...).
8.  **Final Step**: After configuration, go to the **Deployments** tab at the top, find the latest deployment record, and click **Retry deployment** on the right to apply variables.

### Method 2: Manual Deployment (Simple & Direct)

If you don't want to link GitHub, you can copy the code directly.

1.  Log in to [Cloudflare Dashboard](https://dash.cloudflare.com/).
2.  Go to **Workers & Pages** -> **Create Application** -> **Create Worker**, start from `Hello World`.
3.  Name your Worker and click **Deploy**.
4.  Click **Edit code**, copy and paste all code from `worker.js` in this project, overwriting the original code.
5.  Click **Deploy** in the top right corner.
6.  **Configure KV & Variables**:
    * Go to **Settings** -> **Variables**.
    * Add KV Binding: Variable name `TOPIC_MAP`, bind to a KV database.
    * Add Environment Variables: `BOT_TOKEN` and `SUPERGROUP_ID`.
    * Click **Save and Deploy**.

---

### Final Step: Activate Webhook (Crucial)

Regardless of the deployment method, you must manually tell Telegram your Worker address. Visit the following URL in your browser **strictly in order**:

 **Set New Webhook**:
    ```
    [https://api.telegram.org/bot](https://api.telegram.org/bot)<YOUR_TOKEN>/setWebhook?url=<YOUR_WORKER_URL>
    ```
    *Replace `<YOUR_TOKEN>` with your bot token, and `<YOUR_WORKER_URL>` with your Worker's full domain or custom domain (e.g., `https://xxx.workers.dev`).*

If it returns `{"ok":true, "result":true, "description":"Webhook was set"}`, the deployment is successful!

---

## ⚙️ Environment Variables

#### Required Variables

| Variable | Description |
|----------|-------------|
| `BOT_TOKEN` | Telegram Bot Token (from @BotFather) |
| `SUPERGROUP_ID` | Admin group ID (starts with -100) |

#### KV Binding

| Variable | Type | Description |
|----------|------|-------------|
| `TOPIC_MAP` | KV Namespace | Stores user mappings, verification state, topic info |

#### Optional Variables

| Variable | Description |
|----------|-------------|
| `TURNSTILE_SITE_KEY` | Turnstile Site Key (enables Turnstile verification) |
| `TURNSTILE_SECRET_KEY` | Turnstile Secret Key |
| `VERIFICATION_PAGE_URL` | Worker origin URL (without `/verify` suffix, e.g. `https://your-worker.workers.dev`) |
| `SPAM_KEYWORDS` | Spam keywords (comma-separated) |
| `SPAM_SILENCE_MODE` | Silent mode (true/false) |
| `ADMIN_IDS` | Admin user ID whitelist (comma-separated) |
| `API_BASE` | Telegram Bot API base URL (default: `https://api.telegram.org`; allowlist-restricted) |

---

## 🔌 API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Health check, returns `"OK"` |
| `/health` | GET | Health check (same as `/`) |
| `/verify` | GET | Turnstile verification page (HTML). Params: `code`, `uid` |
| `/verify-callback` | POST | Turnstile token verification. Body: `{ token, code, userId }`. Response: `{ success, pendingCount?, error? }` |
| `/` | POST | Telegram webhook receiver (Telegram Update object) |

---

## ❓ FAQ

**Q: Why does clicking the verification button do nothing?**
A: Please check if the Webhook is set correctly. You must ensure Telegram is allowed to send `callback_query` events. Please perform the reset operation in the "Final Step" above.

**Q: Why can't the bot create topics in the group?**
A: Please ensure: 1. Group ID is correct (starts with -100); 2. Topics are enabled in the group; 3. The bot is an administrator and has "Manage Topics" permission.

**Q: How do I add/remove blocked words?**
A: Use `/addword <word>` and `/delword <word>` in the admin group. Use `/listwords` to view all blocked words.

**Q: What is the difference between /trust and /reset?**
A: `/trust` permanently exempts a user from verification (never expires). `/reset` clears the user's verification status, requiring them to verify again on their next message.

**Q: How do I clean up orphaned data?**
A: Use `/cleanup` in the admin group. It scans for deleted topics and expired KV records and cleans them up.

**Q: Can I use a self-hosted Telegram Bot API server?**
A: Yes, set the `API_BASE` environment variable. Note: only `https://api.telegram.org` and `https://api.telegram.dev` are allowed.

---

## 🔒 Security Note

> [!IMPORTANT]
> Please keep your Bot API Token and Turnstile Secret Key safe. Do not commit them to version control.

> [!WARNING]
> The `/verify-callback` endpoint is a public POST endpoint. It validates tokens via Turnstile and code matching, but does not require additional authentication. The verification page (`/verify`) escapes all user-supplied parameters to prevent XSS attacks.

- All secrets should be set via `wrangler secret put` (encrypted) rather than plain environment variables.
- The `API_BASE` variable is restricted to a whitelist to prevent SSRF attacks.
- Rate limiting is applied to message sending and verification requests.

---

## 📈 Star History

[![Star History Chart](https://api.star-history.com/svg?repos=jikssha/telegram_private_chatbot&type=Date)](https://star-history.com/#jikssha/telegram_private_chatbot&Date)

---
**If this project helps you, please give it a Star ⭐️!**
