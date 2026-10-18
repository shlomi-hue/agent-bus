import { createHash } from "node:crypto";
import { chatCss } from "../generated/chat-assets.js";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

const STYLE = chatCss;

const THEME_SOURCE = `try {
  var saved = localStorage.getItem("ab-theme");
  var theme = saved === "light" || saved === "dark"
    ? saved
    : (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  document.documentElement.setAttribute("data-theme", theme);
} catch (e) {}
`;

const THEME_INNER = `\n${THEME_SOURCE}`;
const THEME = `<script>${THEME_INNER}</script>`;

export function chatContentSecurityPolicy(): string {
  const hash = createHash("sha256").update(THEME_INNER).digest("base64");
  return [
    "default-src 'self'",
    `script-src 'self' 'sha256-${hash}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' https:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function unconfiguredPage(): string {
  return layout("Sign in", `
    <main class="narrow">
      <h1>Chat is not configured</h1>
      <p class="muted">Set <code>OWNER_PASSWORD</code> to a password of at least 8 characters, then restart the server. There is no public signup.</p>
      <p><a href="/">Back to agent-bus</a></p>
    </main>
  `);
}

export function loginPage(error?: string): string {
  const notice = error ? `<p class="error">${escapeHtml(error)}</p>` : "";
  return layout("Sign in", `
    <main class="narrow">
      <h1>agent-bus</h1>
      <p class="muted">Sign in to the rooms you share with your agents. This page is for the owner only.</p>
      ${notice}
      <form class="login" method="post" action="/chat/login">
        <label class="sr">Username
          <input name="username" autocomplete="username" value="owner" readonly>
        </label>
        <label>Password
          <input name="password" type="password" autocomplete="current-password" required minlength="8">
        </label>
        <button class="btn btn-primary" type="submit">Sign in</button>
      </form>
    </main>
  `);
}

export function chatPage(): string {
  return layout(
    "Chat",
    `
    <div class="app" id="app">
      <aside class="sb" id="sidebar">
        <div class="sb-head">
          <span class="ws-mark">ab</span>
          <span class="ws-name">agent-bus</span>
          <span class="sp"></span>
        </div>
        <label class="sb-search">
          <span class="sr">Search</span>
          <input id="search" type="search" placeholder="Search or jump to…" autocomplete="off">
          <kbd>⌘K</kbd>
        </label>
        <div class="sb-scroll" id="side-scroll"></div>
        <div class="sb-foot" id="side-foot"></div>
      </aside>
      <main class="main" id="main">
        <header class="hdr" id="header"></header>
        <p id="banner" class="banner" role="alert" hidden></p>
        <div id="stage" class="stage"></div>
        <div id="working-bar" class="working-bar" hidden></div>
        <form id="composer" class="composer" hidden>
          <p id="pause" class="pause" role="status" hidden></p>
          <label class="sr" for="body">Write a message</label>
          <div id="mention-pop" class="mention-pop" role="listbox" aria-label="Mention an agent" hidden></div>
          <textarea id="body" rows="1" placeholder="Write a message" aria-label="Write a message" aria-autocomplete="list" aria-controls="mention-pop" aria-expanded="false"></textarea>
          <div id="mention-hints" class="mention-hints" aria-live="polite" hidden></div>
          <div class="tb">
            <button class="icon-btn" type="button" id="insert-at" title="Mention an agent">@</button>
            <span class="sp"></span>
            <span class="hint">Enter to send</span>
            <button id="send" class="send" type="submit" disabled aria-label="Send">↑</button>
          </div>
        </form>
      </main>
      <aside class="panel" id="tasks" hidden>
        <div class="tp-h">
          <span class="ttl" style="font-weight:600">Tasks</span>
          <span class="sp"></span>
          <div class="seg" id="task-seg">
            <button type="button" class="on" data-status="">Open</button>
            <button type="button" data-status="done">Done</button>
          </div>
          <button id="tasks-close" class="icon-btn" type="button" aria-label="Close tasks">×</button>
        </div>
        <div id="task-list" class="panel-scroll"></div>
      </aside>
    </div>
    <nav class="m-tabs" id="tabs" aria-label="Sections">
      <button class="m-tab on" type="button" data-tab="home">Needs you</button>
      <button class="m-tab" type="button" data-tab="rooms">Rooms</button>
      <button class="m-tab" type="button" data-tab="tasks">Tasks</button>
      <button class="m-tab" type="button" data-tab="activity">Activity</button>
    </nav>
    <dialog id="hook-dialog">
      <form id="hook-form" method="dialog">
        <h2 id="hook-title">Wake-ups</h2>
        <p>Signed POSTs go to this URL when the agent gets a direct message, a mention, or a task from an approved plan. The secret is write-only. Quiet hours shown here are a reminder (23:00–07:00 your local time); the server still delivers immediately.</p>
        <div id="hooks"></div>
        <label>URL <input id="hook-url" name="url" type="url" required placeholder="https://example.com/agent-bus"></label>
        <label>Signing secret <input id="hook-secret" name="secret" type="password" required minlength="16" autocomplete="new-password"></label>
        <div class="dlg-row">
          <button class="btn btn-ghost signout" id="signout" type="button">Sign out</button>
          <button class="btn btn-ghost" id="hook-clear" type="button">Clear</button>
          <button class="btn btn-secondary" id="hook-cancel" type="button">Cancel</button>
          <button class="btn btn-primary" type="submit">Save</button>
        </div>
      </form>
    </dialog>
    <form id="logout" method="post" action="/chat/logout" hidden></form>
    <script src="/chat/app.js"></script>
    `,
  );
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · agent-bus</title>
  ${THEME}
  <style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>`;
}
