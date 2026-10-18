import {
  avatarEl,
  hueFor,
  presenceClass,
  renderPlanCard,
  renderResultCard,
  statusGlyph,
  type PersonLike,
  type PlanView,
  type ResultView,
} from "./cards.js";
import {
  agentRunPaused,
  fullTimestamp,
  groupMessages,
  relativeTime,
  type ChatMessage,
} from "./group.js";
import { icon } from "./icons.js";
import { stripAnswers } from "./text.js";
import { renderMarkdown } from "./markdown.js";
import { applyMention, hintLabel, mentionHints, mentionQuery, suggestMentions } from "./mention-complete.js";

type Presence = "available" | "busy" | "away";
type Person = PersonLike & { id: string; presence: Presence; statusText: string; lastSeenAt: string | null };
type RoomInfo = { id: string; name: string; members: Person[]; latestAt: string | null };
type AgentInfo = Person & { latestAt: string | null };
type State = { owner: Person; roomAgentCap: number; rooms: RoomInfo[]; agents: AgentInfo[] };
type TaskChip = {
  id: string;
  assigneeName: string;
  creatorName: string;
  status: string;
  resultNote: string;
  resultLink: string | null;
  sourceMessageId: string;
  roomName: string | null;
  title: string;
  code: string;
  updatedAt: string;
};
type WireMessage = ChatMessage & {
  toName: string | null;
  roomName: string | null;
  kind: string | null;
  tasks?: TaskChip[];
  plan?: PlanView | null;
  result?: ResultView | null;
};
type Channel = { kind: "room" | "dm"; name: string };
type HomeItem = {
  id: string;
  kind: string;
  filter: string;
  title: string;
  actor: string;
  room: string | null;
  detail: string;
  createdAt: string;
  target: { type: string; id: string; room: string | null; url?: string | null };
  actions: Array<{ id: string; label: string; style: string }>;
  choices: string[];
};
type LiveCard = {
  name: string;
  presence: Presence;
  lastSeenAt: string | null;
  statusText: string;
  pill: string;
  tone: string;
  since: string | null;
  taskCode: string | null;
  taskTitle: string | null;
  progress: number;
  waiting: boolean;
  lines: Array<{ at: string; text: string; current: boolean }>;
};
type Activity = { id: string; at: string; actor: string; actorHuman: boolean; text: string };
type Home = { needsYou: HomeItem[]; live: LiveCard[]; activity: Activity[] };
type View = "home" | "room" | "activity";

const seenCounts = new Map<string, { latestAt: string; count: number }>();

function must<T extends Element>(selector: string): T {
  const node = document.querySelector(selector);
  if (!node) throw new Error(`Missing ${selector}`);
  return node as T;
}

function channelKey(owner: string, channel: Channel): string {
  return `ab-seen:${owner}:${channel.kind}:${channel.name}`;
}

function readSeen(owner: string, channel: Channel): string | null {
  try {
    return sessionStorage.getItem(channelKey(owner, channel));
  } catch {
    return null;
  }
}

function writeSeen(owner: string, channel: Channel, at: string): void {
  try {
    sessionStorage.setItem(channelKey(owner, channel), at);
  } catch {
    /* private mode */
  }
}

async function requestJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { accept: "application/json", ...init?.headers },
  });
  if (response.status === 401) {
    window.location.assign("/chat");
    throw new Error("Sign in required.");
  }
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || "Request failed.");
  return body;
}

export function boot(): void {
  const app = must<HTMLElement>("#app");
  const sideScroll = must<HTMLElement>("#side-scroll");
  const sideFoot = must<HTMLElement>("#side-foot");
  const search = must<HTMLInputElement>("#search");
  const header = must<HTMLElement>("#header");
  const stage = must<HTMLElement>("#stage");
  const workingBar = must<HTMLElement>("#working-bar");
  const composer = must<HTMLFormElement>("#composer");
  const pause = must<HTMLElement>("#pause");
  const banner = must<HTMLElement>("#banner");
  const body = must<HTMLTextAreaElement>("#body");
  const send = must<HTMLButtonElement>("#send");
  const tasksPanel = must<HTMLElement>("#tasks");
  const taskList = must<HTMLElement>("#task-list");
  const tasksClose = must<HTMLButtonElement>("#tasks-close");
  const hookDialog = must<HTMLDialogElement>("#hook-dialog");
  const hookForm = must<HTMLFormElement>("#hook-form");
  const hookTitle = must<HTMLElement>("#hook-title");
  const hookUrl = must<HTMLInputElement>("#hook-url");
  const hookSecret = must<HTMLInputElement>("#hook-secret");
  const hooksEl = must<HTMLElement>("#hooks");
  const tabs = must<HTMLElement>("#tabs");
  const mentionPop = must<HTMLElement>("#mention-pop");
  const mentionHintsEl = must<HTMLElement>("#mention-hints");

  let state: State | null = null;
  let home: Home | null = null;
  let view: View = "home";
  let filter = "all";
  let current: Channel | null = null;
  let messages: WireMessage[] = [];
  let tasks: TaskChip[] = [];
  let editingPlan = "";
  let selected = 0;
  let pinned = true;
  let renderedIds = "";
  let generation = 0;
  let liveCursor = "";
  let liveFailures = 0;
  let pollTimer = 0;
  let source: EventSource | null = null;
  let hookAgent = "";
  let query = "";
  let mentionOptions: string[] = [];
  let mentionIndex = 0;
  let mentionStart = -1;
  let composing = false;

  function showError(text: string): void {
    banner.hidden = text === "";
    banner.textContent = text;
  }

  function personByName(name: string): PersonLike {
    const found = state?.agents.find((agent) => agent.name === name) ?? state?.owner;
    if (found && found.name === name) return found;
    return { name, isHuman: name === state?.owner.name, presence: "available", statusText: "", lastSeenAt: null };
  }

  function showComposer(open: boolean): void {
    composer.hidden = !open;
    workingBar.hidden = !open;
    if (open && current) {
      body.placeholder =
        current.kind === "room"
          ? `Message #${current.name} — @mention an agent to assign a task`
          : `Message ${current.name}`;
    }
  }

  function countFor(channel: Channel, latestAt: string | null): number {
    if (!state || !latestAt) return 0;
    if (current && view === "room" && current.kind === channel.kind && current.name === channel.name) return 0;
    const seen = readSeen(state.owner.name, channel);
    if (!seen || latestAt <= seen) return 0;
    const cached = seenCounts.get(`${channel.kind}:${channel.name}`);
    return cached && cached.latestAt === latestAt ? cached.count : 0;
  }

  function render(): void {
    renderSidebar();
    renderHeader();
    renderStage();
    renderWorking();
    renderPanel();
    renderTabs();
    app.classList.toggle("with-panel", !tasksPanel.hidden);
    app.classList.toggle("show-rooms", view === "room" && window.matchMedia("(max-width: 767px)").matches && !current);
  }

  function renderSidebar(): void {
    if (!state) return;
    sideScroll.replaceChildren();
    const needs = home?.needsYou.length ?? 0;
    sideScroll.append(
      navItem("home", "inbox", "Needs you", needs > 0 ? String(needs) : "", true),
      navItem("activity", "activity", "Activity", "", false),
      navItem("tasks-nav", "tasks", "Tasks", tasks.length ? String(tasks.length) : "", false),
    );
    const roomsLabel = document.createElement("div");
    roomsLabel.className = "sb-section";
    const roomsSpacer = document.createElement("span");
    roomsSpacer.className = "sp";
    roomsLabel.append(document.createTextNode("Rooms"), roomsSpacer, icon("plus", 14));
    sideScroll.append(roomsLabel);
    const rooms = state.rooms.filter((room) => room.name.includes(query));
    if (rooms.length === 0) sideScroll.append(note("No rooms yet."));
    for (const room of rooms) {
      const unread = countFor({ kind: "room", name: room.name }, room.latestAt);
      sideScroll.append(roomItem(room.name, unread));
    }
    const agentsLabel = document.createElement("div");
    agentsLabel.className = "sb-section";
    agentsLabel.textContent = "Agents";
    sideScroll.append(agentsLabel);
    for (const agent of state.agents.filter((agent) => agent.name !== state?.owner.name && agent.name.includes(query))) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "sb-item agent";
      const working = agent.presence === "busy" || tasks.some((task) => task.assigneeName === agent.name && task.status === "working");
      row.append(avatarEl(agent, 20, { working: working && presenceClass(agent) !== "offline" }));
      const stack = document.createElement("span");
      stack.className = "grow";
      const who = document.createElement("div");
      who.className = "who";
      who.textContent = agent.name;
      const status = document.createElement("div");
      status.className = "status trunc";
      status.textContent = agent.statusText || (presenceClass(agent) === "offline" ? "Offline" : agent.presence);
      status.title = agent.statusText;
      stack.append(who, status);
      row.append(stack);
      row.addEventListener("click", () => void openChannel({ kind: "dm", name: agent.name }));
      sideScroll.append(row);
    }
    sideFoot.replaceChildren();
    sideFoot.append(avatarEl(state.owner, 24, { ring: "var(--bg-sidebar)" }));
    const you = document.createElement("div");
    you.className = "grow";
    const name = document.createElement("div");
    name.style.fontWeight = "500";
    name.textContent = displayName(state.owner.name);
    const sub = document.createElement("div");
    sub.className = "faint";
    sub.style.fontSize = "11px";
    sub.textContent = "Owner · online";
    you.append(name, sub);
    const wake = document.createElement("button");
    wake.type = "button";
    wake.className = "icon-btn";
    wake.title = "Wake-ups";
    wake.append(icon("bell", 16));
    wake.addEventListener("click", () => void openHooks());
    const theme = document.createElement("button");
    theme.type = "button";
    theme.className = "icon-btn";
    theme.title = "Toggle theme";
    theme.append(icon(document.documentElement.dataset.theme === "light" ? "moon" : "sun", 16));
    theme.addEventListener("click", () => {
      const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
      document.documentElement.dataset.theme = next;
      try {
        localStorage.setItem("ab-theme", next);
      } catch {
        /* ignore */
      }
      renderSidebar();
    });
    sideFoot.append(you, wake, theme);
  }

  function navItem(id: string, glyph: string, label: string, count: string, accent: boolean): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    const tasksOpen = id === "tasks-nav" && !tasksPanel.hidden;
    button.className = `sb-item${(id === "home" && view === "home") || (id === "activity" && view === "activity") || tasksOpen ? " active" : ""}`;
    button.append(icon(glyph, 16));
    const text = document.createElement("span");
    text.className = "grow";
    text.textContent = label;
    button.append(text);
    if (count) {
      const pill = document.createElement("span");
      pill.className = `count${accent ? " accent" : ""}`;
      pill.textContent = count;
      button.append(pill);
    }
    button.addEventListener("click", () => {
      if (id === "tasks-nav") {
        openTasks();
        return;
      }
      view = id === "activity" ? "activity" : "home";
      current = null;
      showComposer(false);
      if (window.matchMedia("(min-width: 768px)").matches) tasksPanel.hidden = true;
      render();
    });
    return button;
  }

  function roomItem(name: string, unread: number): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    const active = view === "room" && current?.kind === "room" && current.name === name;
    button.className = `sb-item${active ? " active" : ""}${unread ? " unread" : ""}`;
    button.append(icon("hash", 16));
    const text = document.createElement("span");
    text.className = "grow";
    text.textContent = name;
    button.append(text);
    if (unread > 0) {
      const pill = document.createElement("span");
      pill.className = "count accent";
      pill.textContent = unread >= 50 ? "50+" : String(unread);
      button.append(pill);
    }
    button.addEventListener("click", () => void openChannel({ kind: "room", name }));
    return button;
  }

  function renderHeader(): void {
    header.replaceChildren();
    if (view === "home") {
      const title = document.createElement("div");
      title.className = "hdr-title";
      title.append(icon("inbox", 16), document.createTextNode("Needs you"));
      const oldest = home?.needsYou[0]?.createdAt;
      const topic = document.createElement("span");
      topic.className = "hdr-topic";
      topic.textContent = home
        ? `${home.needsYou.length} items${oldest ? ` · oldest ${relativeTime(oldest, new Date())} ago` : ""}`
        : "";
      header.append(title, topic, document.createElement("span"));
      (header.lastChild as HTMLElement).className = "sp";
      header.append(filterSeg());
      return;
    }
    if (view === "activity") {
      const title = document.createElement("div");
      title.className = "hdr-title";
      title.append(icon("activity", 16), document.createTextNode("Activity"));
      header.append(title);
      return;
    }
    if (!current) return;
    if (window.matchMedia("(max-width: 767px)").matches) {
      const back = document.createElement("button");
      back.type = "button";
      back.className = "icon-btn back";
      back.append(icon("arrowLeft", 16));
      back.addEventListener("click", () => {
        current = null;
        view = "home";
        showComposer(false);
        render();
      });
      header.append(back);
    }
    const title = document.createElement("div");
    title.className = "hdr-title";
    title.append(icon("hash", 16), document.createTextNode(current.kind === "room" ? current.name : current.name));
    header.append(title);
    const topic = document.createElement("span");
    topic.className = "hdr-topic trunc";
    if (current.kind === "room") {
      const room = state?.rooms.find((item) => item.name === current?.name);
      const working = (room?.members ?? []).filter(isWorking);
      topic.textContent = `${working.length ? `${working.length} working · ` : ""}${room?.members.length ?? 0} members`;
    } else {
      topic.textContent = "Direct message";
    }
    const spacer = document.createElement("span");
    spacer.className = "sp";
    const tasksButton = document.createElement("button");
    tasksButton.type = "button";
    tasksButton.className = `icon-btn${!tasksPanel.hidden ? " on" : ""}`;
    tasksButton.title = "Tasks";
    tasksButton.append(icon("tasks", 16));
    tasksButton.addEventListener("click", () => {
      if (tasksPanel.hidden) openTasks();
      else {
        tasksPanel.hidden = true;
        render();
      }
    });
    header.append(topic, spacer, tasksButton);
  }

  function filterSeg(): HTMLElement {
    const seg = document.createElement("div");
    seg.className = "seg";
    const items = home?.needsYou ?? [];
    const options = [
      ["all", "All", items.length],
      ["approval", "Approvals", items.filter((item) => item.filter === "approval").length],
      ["question", "Questions", items.filter((item) => item.filter === "question").length],
      ["blocked", "Blocked", items.filter((item) => item.filter === "blocked").length],
    ] as const;
    for (const [id, label, count] of options) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = filter === id ? "on" : "";
      button.append(document.createTextNode(`${label} `), document.createElement("b"));
      button.querySelector("b")!.textContent = String(count);
      button.addEventListener("click", () => {
        filter = id;
        selected = 0;
        render();
      });
      seg.append(button);
    }
    return seg;
  }

  function renderStage(): void {
    if (view === "home") {
      renderHome();
      return;
    }
    if (view === "activity") {
      renderActivity();
      return;
    }
    renderLog(true);
  }

  function renderHome(): void {
    stage.replaceChildren();
    const wrap = document.createElement("div");
    wrap.className = "home";
    const items = (home?.needsYou ?? []).filter((item) => filter === "all" || item.filter === filter);
    const card = document.createElement("div");
    card.className = "card";
    card.style.marginBottom = "24px";
    if (items.length === 0) card.append(note("Nothing is waiting on you."));
    items.forEach((item, index) => card.append(needsRow(item, index === selected)));
    wrap.append(card);
    const liveHead = document.createElement("div");
    liveHead.className = "sec-h";
    liveHead.append(document.createElement("h2"));
    liveHead.querySelector("h2")!.textContent = "Live";
    const working = (home?.live ?? []).filter((card) => card.tone === "accent").length;
    const waiting = (home?.live ?? []).filter((card) => card.waiting).length;
    if (working) liveHead.append(pill(`${working} working`, "ok"));
    if (waiting) liveHead.append(pill(`${waiting} waiting`, "neutral"));
    wrap.append(liveHead);
    const grid = document.createElement("div");
    grid.className = "live";
    for (const card of home?.live ?? []) grid.append(liveCard(card));
    wrap.append(grid);
    const actHead = document.createElement("div");
    actHead.className = "sec-h";
    const heading = document.createElement("h2");
    heading.textContent = "Earlier today";
    actHead.append(heading);
    wrap.append(actHead, activityList(home?.activity ?? []));
    stage.append(wrap);
    showComposer(false);
  }

  function needsRow(item: HomeItem, on: boolean): HTMLElement {
    const row = document.createElement("div");
    row.className = "ny";
    if (on) row.style.background = "var(--bg-hover)";
    const kind = document.createElement("div");
    kind.className = `kind ${item.kind === "blocked" ? "blk" : item.kind === "question" ? "q" : "appr"}`;
    kind.append(icon(item.kind === "blocked" ? "alert" : item.kind === "question" ? "help" : item.kind === "review" ? "pr" : "plan", 16));
    const copy = document.createElement("div");
    copy.style.minWidth = "0";
    const title = document.createElement("div");
    title.className = "t1 trunc";
    title.textContent = item.title;
    const meta = document.createElement("div");
    meta.className = "t2";
    meta.append(avatarEl(personByName(item.actor), 16));
    meta.append(document.createTextNode(`${item.actor}${item.room ? ` · #${item.room}` : ""}${item.detail ? ` · ${item.detail}` : ""} · ${relativeTime(item.createdAt, new Date())} ago`));
    copy.append(title, meta);
    const acts = document.createElement("div");
    acts.className = "acts";
    for (const action of item.actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `btn btn-${action.style === "primary" ? "primary" : action.style === "secondary" ? "secondary" : "ghost"}`;
      button.textContent = action.label;
      button.addEventListener("click", () => void runAction(item, action.id));
      acts.append(button);
    }
    row.append(kind, copy, acts);
    return row;
  }

  function liveCard(card: LiveCard): HTMLElement {
    const shell = document.createElement("div");
    shell.className = "card lc";
    const body = document.createElement("div");
    body.className = "card-b";
    const top = document.createElement("div");
    top.className = "row";
    const person = personByName(card.name);
    const working = card.tone === "accent" && presenceClass(person) !== "offline";
    top.append(avatarEl({ ...person, presence: card.presence, lastSeenAt: card.lastSeenAt, statusText: card.statusText }, 24, { working }));
    const name = document.createElement("span");
    name.style.fontWeight = "600";
    name.textContent = card.name;
    top.append(name, pill(card.pill, card.tone === "warn" ? "warn" : card.tone === "accent" ? "accent" : "neutral"));
    const spacer = document.createElement("span");
    spacer.className = "sp";
    const since = document.createElement("span");
    since.className = "faint mono";
    since.style.fontSize = "11px";
    since.textContent = card.since ? relativeTime(card.since, new Date()) : "";
    top.append(spacer, since);
    const task = document.createElement("div");
    task.className = "row";
    task.style.marginTop = "10px";
    if (card.taskCode) task.append(Object.assign(document.createElement("span"), { className: "mono faint", textContent: card.taskCode }));
    const title = document.createElement("span");
    title.className = "trunc";
    title.style.fontWeight = "500";
    title.textContent = card.taskTitle || card.statusText || "Idle";
    task.append(title);
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.style.marginTop = "8px";
    const fill = document.createElement("i");
    fill.style.width = `${card.progress}%`;
    fill.style.background = card.waiting ? "var(--warning)" : `var(--id-${hueFor(card.name, false)}-fg, var(--accent))`;
    bar.append(fill);
    const log = document.createElement("div");
    log.className = "log";
    for (const line of card.lines) {
      const row = document.createElement("div");
      if (line.current) row.className = "now";
      const time = document.createElement("span");
      time.className = "tm";
      time.textContent = clock(line.at);
      row.append(time, document.createTextNode(line.text));
      log.append(row);
    }
    body.append(top, task, bar, log);
    shell.append(body);
    return shell;
  }

  function renderActivity(): void {
    stage.replaceChildren();
    const wrap = document.createElement("div");
    wrap.className = "home";
    wrap.append(activityList(home?.activity ?? []));
    stage.append(wrap);
    showComposer(false);
  }

  function activityList(items: Activity[]): HTMLElement {
    const list = document.createElement("div");
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "act";
      row.append(avatarEl({ name: item.actor, isHuman: item.actorHuman }, 20));
      const text = document.createElement("span");
      text.className = "trunc";
      const strong = document.createElement("b");
      strong.style.fontWeight = "500";
      strong.textContent = item.actorHuman && item.actor === state?.owner.name ? "You" : item.actor;
      text.append(strong, document.createTextNode(` ${item.text}`));
      const time = document.createElement("span");
      time.className = "faint";
      time.style.fontSize = "12px";
      time.textContent = clock(item.at);
      row.append(text, time);
      list.append(row);
    }
    return list;
  }

  function renderLog(forcePin: boolean): void {
    const pin = forcePin || pinned;
    const ids = messages.map((message) => `${message.id}:${message.plan?.status ?? ""}:${message.result?.status ?? ""}:${message.tasks?.map((task) => task.status).join(",") ?? ""}`).join("\n");
    if (ids === renderedIds && stage.querySelector(".feed") && !forcePin) return;
    renderedIds = ids;
    stage.replaceChildren();
    const feed = document.createElement("div");
    feed.className = "feed";
    feed.id = "log";
    if (messages.length === 0) feed.append(note(current ? "No messages yet." : "Pick a room."));
    for (const block of groupMessages(messages, new Date(), undefined, localTimeZone())) {
      if (block.kind === "day") {
        const day = document.createElement("div");
        day.className = "day";
        day.textContent = block.label;
        feed.append(day);
        continue;
      }
      for (let index = 0; index < block.messages.length; index += 1) {
        const message = block.messages[index];
        if (!message) continue;
        const grouped = index > 0;
        const wire = messages.find((item) => item.id === message.id);
        if (wire?.kind === "plan_decision" || wire?.kind === "task_status") {
          const line = document.createElement("div");
          line.className = "sysline";
          line.textContent = message.body;
          feed.append(line);
          continue;
        }
        const cluster: WireMessage[] = [];
        if (wire?.result) {
          while (index + 1 < block.messages.length) {
            const next = block.messages[index + 1];
            const nextWire = next ? messages.find((item) => item.id === next.id) : undefined;
            if (!nextWire?.result || next.fromName !== message.fromName) break;
            cluster.push(nextWire);
            index += 1;
          }
        }
        feed.append(renderMessage(message, grouped, wire, cluster));
      }
    }
    stage.append(feed);
    if (pin) stage.scrollTop = stage.scrollHeight;
    updatePause();
    showComposer(Boolean(current));
  }

  function renderMessage(message: ChatMessage, grouped: boolean, wire?: WireMessage, cluster: WireMessage[] = []): HTMLElement {
    const row = document.createElement("article");
    row.className = `msg${grouped ? " cont" : ""}`;
    const ownerName = state?.owner.name ?? "";
    if (message.body.includes(`@${ownerName}`)) row.classList.add("me-mention");
    const slot = document.createElement("div");
    slot.className = "av-slot";
    if (!grouped) slot.append(avatarEl(personByName(message.fromName), 32, { ring: "var(--bg-app)" }));
    const main = document.createElement("div");
    if (!grouped) {
      const head = document.createElement("div");
      head.className = "mh";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = message.fromName;
      head.append(name);
      if (!message.fromIsHuman) {
        const tag = document.createElement("span");
        tag.className = "tag-agent";
        tag.textContent = "Agent";
        head.append(tag);
      }
      const time = document.createElement("time");
      time.dateTime = message.createdAt;
      time.className = "time";
      time.dataset.ts = message.createdAt;
      time.textContent = relativeTime(message.createdAt, new Date());
      time.title = fullTimestamp(message.createdAt);
      head.append(time);
      main.append(head);
    }
    const text = document.createElement("div");
    text.className = "mb";
    text.innerHTML = renderMarkdown(stripAnswers(message.body));
    highlightMentions(text);
    main.append(text);
    const chips = (wire?.tasks ?? []).filter((task) => task.sourceMessageId === message.id);
    if (chips.length > 0 && !wire?.plan) {
      const list = document.createElement("div");
      list.className = "chips";
      for (const task of chips) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "chip";
        chip.append(statusGlyph(task.status), Object.assign(document.createElement("span"), { className: "id", textContent: task.code || task.id.slice(0, 8) }));
        const title = document.createElement("span");
        title.className = "t";
        title.textContent = task.title || task.status;
        chip.append(title, avatarEl(personByName(task.assigneeName), 16));
        chip.addEventListener("click", () => openTasks());
        list.append(chip);
      }
      main.append(list);
    }
    if (wire?.plan) {
      const members = state?.agents.map((agent) => agent.name) ?? [];
      main.append(
        renderPlanCard(wire.plan, {
          editing: editingPlan === wire.plan.id,
          members,
          onReject: () => void planAction(wire.plan!.id, "reject"),
          onEdit: () => {
            editingPlan = wire.plan!.id;
            renderedIds = "";
            renderLog(false);
          },
          onCancel: () => {
            editingPlan = "";
            renderedIds = "";
            renderLog(false);
          },
          onApprove: () => void planAction(wire.plan!.id, "approve"),
          onSave: (tasks) => void savePlan(wire.plan!.id, tasks),
          onPause: () => void planAction(wire.plan!.id, wire.plan!.status === "paused" ? "resume" : "pause"),
          onOpenTasks: () => openTasks(),
        }),
      );
    }
    const resultWires = [wire, ...cluster].filter((item): item is WireMessage => Boolean(item?.result));
    if (resultWires.length > 0) {
      const grid = document.createElement("div");
      grid.className = "results";
      for (const item of resultWires) {
        const card = item.result;
        if (!card) continue;
        grid.append(
          renderResultCard(card, {
            onApprove: () => void resultAction(card.id, "approve"),
            onChanges: () => void resultAction(card.id, "changes"),
            onUndo: () => void resultAction(card.id, "undo"),
            onRerun: () => void rerunTests(card.author),
          }),
        );
      }
      main.append(grid);
    }
    row.append(slot, main);
    return row;
  }

  function renderWorking(): void {
    if (view !== "room" || current?.kind !== "room") {
      workingBar.hidden = true;
      return;
    }
    const room = state?.rooms.find((item) => item.name === current?.name);
    const active = (room?.members ?? []).filter(isWorking).slice(0, 2);
    workingBar.replaceChildren();
    if (active.length === 0) {
      workingBar.hidden = true;
      return;
    }
    workingBar.hidden = false;
    for (const person of active) {
      const task = tasks.find((item) => item.assigneeName === person.name && item.status === "working");
      workingBar.append(avatarEl(person, 16, { working: true }));
      const text = document.createElement("span");
      text.className = "shimmer";
      text.textContent = `${person.name} ${person.statusText || "is working"}${task?.code ? ` · ${task.code}` : ""}`;
      workingBar.append(text);
    }
  }

  function renderPanel(): void {
    if (tasksPanel.hidden) return;
    taskList.replaceChildren();
    const open = tasks.filter((task) => task.status !== "done");
    const done = tasks.filter((task) => task.status === "done");
    const showDone = taskList.dataset.mode === "done";
    const groups: Array<[string, TaskChip[]]> = showDone
      ? [["Done", done]]
      : [
          ["In progress", open.filter((task) => task.status === "working")],
          ["Needs review", open.filter((task) => task.status === "open" && /review/i.test(task.title + task.resultNote))],
          ["Blocked", open.filter((task) => task.status === "blocked")],
          ["Queued", open.filter((task) => task.status === "open" && !/review/i.test(task.title + task.resultNote))],
        ];
    for (const [label, rows] of groups) {
      if (rows.length === 0) continue;
      const group = document.createElement("div");
      group.className = "tp-group";
      const head = document.createElement("div");
      head.className = "gh";
      head.textContent = `${label}  ${rows.length}`;
      group.append(head);
      for (const task of rows) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "tp-row";
        const title = document.createElement("span");
        title.className = "trunc";
        title.textContent = task.title || task.resultNote || task.status;
        row.append(statusGlyph(task.status), Object.assign(document.createElement("span"), { className: "id", textContent: task.code || "" }), title, avatarEl(personByName(task.assigneeName), 20));
        row.addEventListener("click", () => {
          if (task.roomName) void openChannel({ kind: "room", name: task.roomName });
        });
        group.append(row);
      }
      taskList.append(group);
    }
    if (taskList.childElementCount === 0) taskList.append(note("No tasks for this filter."));
  }

  function renderTabs(): void {
    const buttons = tabs.querySelectorAll<HTMLButtonElement>("button");
    buttons.forEach((button) => {
      const tab = button.dataset.tab;
      button.classList.toggle("on", (tab === "home" && view === "home") || (tab === "activity" && view === "activity") || (tab === "rooms" && view === "room") || (tab === "tasks" && !tasksPanel.hidden));
    });
  }

  function updatePause(): void {
    if (!state || current?.kind !== "room") {
      pause.hidden = true;
      return;
    }
    const paused = agentRunPaused(messages, state.roomAgentCap);
    pause.hidden = !paused;
    pause.textContent = paused
      ? `Agents are paused after ${state.roomAgentCap} messages in a row. Send a message and they can continue.`
      : "";
  }

  function isWorking(person: Person): boolean {
    return presenceClass(person) !== "offline" && (person.presence === "busy" || tasks.some((task) => task.assigneeName === person.name && task.status === "working"));
  }

  async function openChannel(channel: Channel): Promise<void> {
    view = "room";
    current = channel;
    messages = [];
    renderedIds = "";
    pinned = true;
    editingPlan = "";
    if (window.matchMedia("(min-width: 1280px)").matches) tasksPanel.hidden = false;
    render();
    await loadMessages(true);
    if (!tasksPanel.hidden) await loadTasks();
  }

  async function loadMessages(reset: boolean): Promise<void> {
    if (!current) return;
    const ticket = ++generation;
    const channel = current;
    const since = reset ? null : messages.at(-1)?.createdAt ?? null;
    const key = channel.kind === "room" ? "room" : "dm";
    const url = `/chat/api/messages?${key}=${encodeURIComponent(channel.name)}${since ? `&since=${encodeURIComponent(since)}` : ""}`;
    const data = await requestJSON<{ messages: WireMessage[] }>(url);
    if (ticket !== generation || current?.name !== channel.name) return;
    if (reset) messages = data.messages ?? [];
    else {
      const known = new Set(messages.map((message) => message.id));
      for (const message of data.messages ?? []) if (!known.has(message.id)) messages.push(message);
    }
    for (const message of messages) {
      for (const task of message.tasks ?? []) {
        const index = tasks.findIndex((item) => item.id === task.id);
        if (index >= 0) tasks[index] = task;
        else tasks.push(task);
      }
    }
    if (state) {
      const latest = messages.at(-1)?.createdAt;
      if (latest) writeSeen(state.owner.name, channel, latest);
    }
    renderLog(reset);
    renderSidebar();
  }

  async function loadHome(): Promise<void> {
    home = await requestJSON<Home>("/chat/api/home");
    if (view === "home" || view === "activity") render();
    else renderSidebar();
  }

  async function loadTasks(): Promise<void> {
    const data = await requestJSON<{ tasks: TaskChip[] }>("/chat/api/tasks");
    tasks = data.tasks ?? [];
    renderPanel();
    renderSidebar();
    renderWorking();
  }

  function openTasks(): void {
    tasksPanel.hidden = false;
    render();
    void loadTasks().catch((error: unknown) => showError(error instanceof Error ? error.message : "Could not load tasks."));
  }

  async function refreshState(): Promise<void> {
    state = await requestJSON<State>("/chat/api/state");
    await loadHome();
    await loadTasks();
    render();
  }

  async function refreshAll(): Promise<void> {
    await refreshState();
    if (view === "room" && current) await loadMessages(false);
  }

  async function runAction(item: HomeItem, action: string): Promise<void> {
    try {
      if (action === "review" || action === "open" || action === "reply") {
        if (item.target.room) await openChannel({ kind: "room", name: item.target.room });
        if (action === "reply") body.focus();
        return;
      }
      if (action === "diff" && item.target.url) {
        window.open(item.target.url, "_blank", "noopener");
        return;
      }
      if (item.target.type === "plan" && (action === "approve" || action === "reject")) {
        await planAction(item.target.id, action);
        return;
      }
      if (item.target.type === "result" && (action === "approve" || action === "changes")) {
        await resultAction(item.target.id, action);
        return;
      }
      if (item.target.type === "task" && action === "resolve") {
        await requestJSON(`/chat/api/tasks/${item.target.id}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "done", result: "Resolved by the owner" }),
        });
      }
      if (item.target.type === "task" && action.startsWith("answer:")) {
        const answer = action.slice("answer:".length);
        if (item.target.room) {
          await requestJSON("/chat/api/messages", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ room: item.target.room, body: answer, metadata: { kind: "quick_answer" } }),
          });
        }
        await requestJSON(`/chat/api/tasks/${item.target.id}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "done", result: answer }),
        });
      }
      await refreshAll();
    } catch (error) {
      showError(error instanceof Error ? error.message : "Action failed.");
    }
  }

  let busyAction = false;

  function setCardsBusy(busy: boolean): void {
    for (const button of document.querySelectorAll<HTMLButtonElement>(".card button, .ny .acts button")) {
      button.disabled = busy;
    }
  }

  async function planAction(id: string, action: string): Promise<void> {
    if (busyAction) return;
    busyAction = true;
    setCardsBusy(true);
    try {
      await requestJSON(`/chat/api/plans/${id}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      editingPlan = "";
      await refreshAll();
    } catch (error) {
      showError(error instanceof Error ? error.message : "Action failed.");
    } finally {
      busyAction = false;
      setCardsBusy(false);
    }
  }

  async function savePlan(id: string, tasks: Array<{ title: string; assignee: string; estimate: string; depends_on: string }>): Promise<void> {
    if (busyAction) return;
    busyAction = true;
    setCardsBusy(true);
    try {
      await requestJSON(`/chat/api/plans/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tasks }),
      });
      editingPlan = "";
      await refreshAll();
    } catch (error) {
      showError(error instanceof Error ? error.message : "Action failed.");
    } finally {
      busyAction = false;
      setCardsBusy(false);
    }
  }

  async function resultAction(id: string, action: string): Promise<void> {
    const note = action === "changes" ? window.prompt("What should change?") ?? "" : "";
    if (action === "changes" && note.trim() === "") return;
    if (busyAction) return;
    busyAction = true;
    setCardsBusy(true);
    try {
      await requestJSON(`/chat/api/results/${id}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note }),
      });
      await refreshAll();
    } catch (error) {
      showError(error instanceof Error ? error.message : "Action failed.");
    } finally {
      busyAction = false;
      setCardsBusy(false);
    }
  }

  async function rerunTests(author: string): Promise<void> {
    if (!current || current.kind !== "room") return;
    await requestJSON("/chat/api/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ room: current.name, body: `@${author} please re-run the failed tests` }),
    });
    await refreshAll();
  }

  async function openHooks(): Promise<void> {
    const data = await requestJSON<{ webhooks: Array<{ name: string; url: string | null; configured: boolean }> }>("/chat/api/webhooks");
    hooksEl.replaceChildren();
    for (const hook of data.webhooks) {
      const row = document.createElement("div");
      row.className = "hook-row";
      const label = document.createElement("span");
      label.textContent = `${hook.name}${hook.configured ? ` · ${hook.url}` : " · not set"}`;
      const pick = document.createElement("button");
      pick.type = "button";
      pick.className = "btn btn-secondary btn-sm";
      pick.textContent = "Edit";
      pick.addEventListener("click", () => {
        hookAgent = hook.name;
        hookTitle.textContent = `Wake-ups · ${hook.name}`;
        hookUrl.value = hook.url ?? "";
        hookSecret.value = "";
      });
      row.append(label, pick);
      hooksEl.append(row);
    }
    hookDialog.showModal();
  }

  function stopPoll(): void {
    if (pollTimer) window.clearInterval(pollTimer);
    pollTimer = 0;
  }

  function startPoll(): void {
    if (pollTimer) return;
    pollTimer = window.setInterval(() => {
      void refreshAll().catch((error: unknown) => showError(error instanceof Error ? error.message : "Could not refresh."));
    }, 3000);
    window.setTimeout(() => {
      stopPoll();
      liveFailures = 0;
      connectLive();
    }, 30_000);
  }

  function connectLive(): void {
    source?.close();
    const url = liveCursor ? `/chat/api/events?since=${encodeURIComponent(liveCursor)}` : "/chat/api/events";
    const events = new EventSource(url);
    source = events;
    let closed = false;
    const take = (event: Event) => {
      if (closed) return;
      closed = true;
      liveFailures = 0;
      const data = JSON.parse((event as MessageEvent).data) as { cursor?: string };
      if (data.cursor) liveCursor = data.cursor;
      events.close();
      const reload = (event as MessageEvent).type === "update" ? refreshAll() : Promise.resolve();
      void reload.finally(() => connectLive());
    };
    events.addEventListener("update", take);
    events.addEventListener("bye", take);
    events.onerror = () => {
      if (closed) return;
      closed = true;
      events.close();
      liveFailures += 1;
      if (liveFailures >= 3) startPoll();
      else window.setTimeout(connectLive, Math.min(8_000, 400 * liveFailures));
    };
  }

  search.addEventListener("input", () => {
    query = search.value.trim().toLowerCase();
    renderSidebar();
  });
  search.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      search.value = "";
      query = "";
      renderSidebar();
    }
  });
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      search.focus();
    }
    if (view !== "home" || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    const items = (home?.needsYou ?? []).filter((item) => filter === "all" || item.filter === filter);
    if (event.key === "j") {
      selected = Math.min(items.length - 1, selected + 1);
      renderHome();
    }
    if (event.key === "k") {
      selected = Math.max(0, selected - 1);
      renderHome();
    }
    if (event.key.toLowerCase() === "a" && items[selected]) void runAction(items[selected], "approve");
    if (event.key.toLowerCase() === "r" && items[selected]) void runAction(items[selected], "reply");
  });
  function mentionCandidates(): { names: string[]; members: string[] | null } {
    const owner = state?.owner.name ?? "";
    const known = (state?.agents ?? []).map((agent) => agent.name).filter((name) => name !== owner);
    if (current?.kind === "room") {
      const room = state?.rooms.find((item) => item.name === current?.name);
      const members = (room?.members ?? []).map((member) => member.name).filter((name) => name !== owner);
      return { names: members, members };
    }
    return { names: known, members: null };
  }

  function closeMentions(): void {
    mentionOptions = [];
    mentionStart = -1;
    mentionPop.hidden = true;
    mentionPop.replaceChildren();
    body.setAttribute("aria-expanded", "false");
    body.removeAttribute("aria-activedescendant");
  }

  function renderMentionPop(): void {
    mentionPop.replaceChildren();
    mentionOptions.forEach((name, index) => {
      const option = document.createElement("button");
      option.type = "button";
      option.id = `mention-opt-${index}`;
      option.className = `mention-opt${index === mentionIndex ? " on" : ""}`;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", index === mentionIndex ? "true" : "false");
      const person = personByName(name);
      const label = document.createElement("span");
      label.className = "grow trunc";
      label.textContent = name;
      const presence = document.createElement("span");
      presence.className = "faint";
      presence.textContent = person.presence ?? "";
      option.append(avatarEl(person, 20), label, presence);
      // mousedown keeps focus in the textarea so the caret position survives.
      option.addEventListener("mousedown", (event) => {
        event.preventDefault();
        pickMention(index);
      });
      mentionPop.append(option);
    });
    mentionPop.hidden = mentionOptions.length === 0;
    body.setAttribute("aria-expanded", mentionPop.hidden ? "false" : "true");
    if (mentionPop.hidden) body.removeAttribute("aria-activedescendant");
    else body.setAttribute("aria-activedescendant", `mention-opt-${mentionIndex}`);
  }

  function updateMentions(): void {
    const caret = body.selectionStart ?? body.value.length;
    const found = body.selectionStart === body.selectionEnd ? mentionQuery(body.value, caret) : null;
    if (!found) {
      closeMentions();
    } else {
      const next = suggestMentions(found.query, mentionCandidates().names);
      if (found.start !== mentionStart || next.join("\0") !== mentionOptions.join("\0")) mentionIndex = 0;
      mentionStart = found.start;
      mentionOptions = next;
      renderMentionPop();
    }
    const { members } = mentionCandidates();
    const known = (state?.agents ?? []).map((agent) => agent.name);
    const active = found && mentionOptions.length > 0 ? found.query.toLowerCase() : "";
    const hints = mentionHints(body.value, known, members).filter((hint) => hint.name !== active);
    mentionHintsEl.replaceChildren();
    for (const hint of hints) {
      const chip = document.createElement("span");
      chip.className = `mention-hint ${hint.status}`;
      chip.textContent = hintLabel(hint);
      mentionHintsEl.append(chip);
    }
    mentionHintsEl.hidden = hints.length === 0;
  }

  function pickMention(index: number): void {
    const name = mentionOptions[index];
    if (!name || mentionStart < 0) return;
    const caret = body.selectionStart ?? body.value.length;
    const next = applyMention(body.value, mentionStart, caret, name);
    body.value = next.text;
    body.setSelectionRange(next.caret, next.caret);
    closeMentions();
    body.focus();
    body.dispatchEvent(new Event("input"));
  }

  body.addEventListener("input", () => {
    body.style.height = "auto";
    body.style.height = `${Math.min(body.scrollHeight, 160)}px`;
    send.disabled = body.value.trim() === "";
    send.classList.toggle("ready", body.value.trim() !== "");
    updateMentions();
  });
  body.addEventListener("click", () => updateMentions());
  body.addEventListener("keyup", (event) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End") updateMentions();
  });
  body.addEventListener("blur", () => closeMentions());
  body.addEventListener("compositionstart", () => {
    composing = true;
  });
  body.addEventListener("compositionend", () => {
    composing = false;
    updateMentions();
  });
  body.addEventListener("keydown", (event) => {
    if (event.isComposing || composing || event.key === "Process") return;
    if (!mentionPop.hidden && mentionOptions.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        mentionIndex = (mentionIndex + step + mentionOptions.length) % mentionOptions.length;
        renderMentionPop();
        return;
      }
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        event.preventDefault();
        pickMention(mentionIndex);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeMentions();
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      composer.requestSubmit();
    }
  });
  must<HTMLButtonElement>("#insert-at").addEventListener("click", () => {
    const start = body.selectionStart ?? body.value.length;
    const end = body.selectionEnd ?? start;
    const before = body.value.slice(0, start);
    const prefix = before.length === 0 || /[^A-Za-z0-9_]$/.test(before) ? "@" : " @";
    body.value = before + prefix + body.value.slice(end);
    const caret = before.length + prefix.length;
    body.focus();
    body.setSelectionRange(caret, caret);
    body.dispatchEvent(new Event("input"));
  });
  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!current || body.value.trim() === "") return;
    const text = body.value;
    const payload = current.kind === "room" ? { room: current.name, body: text } : { dm: current.name, body: text };
    void requestJSON<{ message: WireMessage }>("/chat/api/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(async (data) => {
        body.value = "";
        closeMentions();
        mentionHintsEl.replaceChildren();
        mentionHintsEl.hidden = true;
        send.disabled = true;
        send.classList.remove("ready");
        if (!messages.some((message) => message.id === data.message.id)) messages.push(data.message);
        renderedIds = "";
        renderLog(true);
        await loadTasks();
      })
      .catch((error: unknown) => showError(error instanceof Error ? error.message : "Send failed."));
  });
  tasksClose.addEventListener("click", () => {
    tasksPanel.hidden = true;
    render();
  });
  for (const button of must<HTMLElement>("#task-seg").querySelectorAll<HTMLButtonElement>("button")) {
    button.addEventListener("click", () => {
      taskList.dataset.mode = button.dataset.status ?? "";
      for (const peer of must<HTMLElement>("#task-seg").querySelectorAll("button")) peer.classList.toggle("on", peer === button);
      renderPanel();
    });
  }
  tabs.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const button = target.closest("button");
    if (!(button instanceof HTMLButtonElement)) return;
    const tab = button.dataset.tab;
    if (tab === "tasks") {
      openTasks();
      return;
    }
    if (tab === "rooms") {
      view = "room";
      current = null;
      showComposer(false);
      render();
      return;
    }
    tasksPanel.hidden = true;
    view = tab === "activity" ? "activity" : "home";
    current = null;
    showComposer(false);
    render();
  });
  hookForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void requestJSON("/chat/api/webhooks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: hookAgent, url: hookUrl.value, secret: hookSecret.value }),
    })
      .then(() => hookDialog.close())
      .catch((error: unknown) => showError(error instanceof Error ? error.message : "Could not save the wake-up URL."));
  });
  must<HTMLButtonElement>("#hook-clear").addEventListener("click", () => {
    void requestJSON(`/chat/api/webhooks?name=${encodeURIComponent(hookAgent)}`, { method: "DELETE" }).then(() => hookDialog.close());
  });
  must<HTMLButtonElement>("#hook-cancel").addEventListener("click", () => hookDialog.close());
  must<HTMLButtonElement>("#signout").addEventListener("click", () => must<HTMLFormElement>("#logout").submit());
  stage.addEventListener("scroll", () => {
    pinned = stage.scrollHeight - stage.scrollTop - stage.clientHeight < 72;
  });
  window.setInterval(() => {
    for (const node of document.querySelectorAll<HTMLElement>("[data-ts]")) {
      if (node.dataset.ts) node.textContent = relativeTime(node.dataset.ts, new Date());
    }
  }, 30_000);

  void refreshState()
    .then(() => connectLive())
    .catch((error: unknown) => showError(error instanceof Error ? error.message : "Could not load chat."));
}

function highlightMentions(root: HTMLElement): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    nodes.push(current as Text);
    current = walker.nextNode();
  }
  const pattern = /@[a-z][a-z0-9_-]{0,63}/gi;
  for (const node of nodes) {
    const parent = node.parentElement;
    if (!parent || parent.closest("code, pre, a")) continue;
    const value = node.nodeValue ?? "";
    if (!value.includes("@")) continue;
    pattern.lastIndex = 0;
    if (!pattern.test(value)) continue;
    pattern.lastIndex = 0;
    const fragment = document.createDocumentFragment();
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(value))) {
      fragment.append(value.slice(last, match.index));
      const span = document.createElement("span");
      span.className = "mention";
      span.textContent = match[0];
      fragment.append(span);
      last = match.index + match[0].length;
    }
    fragment.append(value.slice(last));
    node.replaceWith(fragment);
  }
}

function note(text: string): HTMLElement {
  const node = document.createElement("p");
  node.className = "empty-note";
  node.textContent = text;
  return node;
}

function pill(text: string, tone: string): HTMLElement {
  const node = document.createElement("span");
  node.className = `pill ${tone === "ok" ? "ok" : tone === "warn" ? "warn" : tone === "accent" ? "accent" : "neutral"}`;
  node.textContent = text;
  return node;
}

function clock(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

function displayName(name: string): string {
  return name ? name.slice(0, 1).toUpperCase() + name.slice(1) : name;
}

function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

boot();
