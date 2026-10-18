import { initials, relativeTime } from "./group.js";
import { icon } from "./icons.js";
import { renderMarkdown } from "./markdown.js";

export type PersonLike = {
  name: string;
  isHuman: boolean;
  presence?: "available" | "busy" | "away";
  lastSeenAt?: string | null;
  statusText?: string;
};

export type PlanItemView = {
  id: string;
  position: number;
  code: string;
  title: string;
  assignee: string;
  estimate: string;
  dependsOn: string;
  taskId: string | null;
  taskStatus: string | null;
  resultNote: string;
  updatedAt: string | null;
};

export type PlanView = {
  id: string;
  room: string;
  author: string;
  messageId: string;
  title: string;
  summary: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
  items: PlanItemView[];
};

export type ResultView = {
  id: string;
  room: string;
  author: string;
  messageId: string;
  kind: string;
  payload: Record<string, unknown>;
  status: string;
  decisionNote: string;
  decidedAt: string | null;
  createdAt: string;
};

const HUES = ["codex", "claude", "grok", "rose", "olive"];

export function hueFor(name: string, isHuman: boolean): string {
  const value = name.toLowerCase();
  if (isHuman) return "owner";
  if (value.includes("codex")) return "codex";
  if (value.includes("claude")) return "claude";
  if (value.includes("grok")) return "grok";
  let hash = 0;
  for (const character of value) hash = (hash * 33 + character.charCodeAt(0)) >>> 0;
  return HUES[hash % HUES.length] ?? "codex";
}

export function monogram(name: string, isHuman: boolean): string {
  const value = name.toLowerCase();
  if (isHuman) return initials(name);
  if (value.includes("codex")) return "CX";
  if (value.includes("claude")) return "CL";
  if (value.includes("grok")) return "GK";
  return initials(name);
}

export function presenceClass(person: PersonLike): "online" | "away" | "offline" {
  if (!person.lastSeenAt) return "offline";
  if (Date.now() - Date.parse(person.lastSeenAt) > 120_000) return "offline";
  if (person.presence === "away") return "away";
  return "online";
}

export function avatarEl(
  person: PersonLike,
  size: 16 | 20 | 24 | 32 | 40,
  options: { working?: boolean; ring?: string } = {},
): HTMLElement {
  const node = document.createElement("span");
  const hue = hueFor(person.name, person.isHuman);
  node.className = `av av-${size} ${person.isHuman ? "human" : "agent"} av-${hue}${options.working ? " working" : ""}`;
  node.textContent = monogram(person.name, person.isHuman);
  node.title = person.statusText ? `${person.name} · ${person.statusText}` : person.name;
  if (options.ring || size >= 20) {
    const dot = document.createElement("i");
    dot.className = `dot ${presenceClass(person)}`;
    if (options.ring) dot.style.borderColor = options.ring;
    node.append(dot);
  }
  return node;
}

export function statusGlyph(status: string | null): HTMLElement {
  const node = document.createElement("i");
  const mapped =
    status === "working" ? "running" : status === "done" ? "done" : status === "blocked" ? "blocked" : status === "open" ? "todo" : "queued";
  node.className = `st ${mapped}`;
  node.title = status ?? "queued";
  return node;
}

function decisionLabel(prefix: string, decidedAt: string | null, fallback: string): HTMLElement {
  if (!decidedAt) return el("span", "kv", fallback);
  const label = el("span", "kv");
  label.append(document.createTextNode(`${prefix} `), timeEl(decidedAt));
  return label;
}

function timeEl(iso: string): HTMLElement {
  const time = document.createElement("time");
  time.dateTime = iso;
  time.dataset.ts = iso;
  time.textContent = relativeTime(iso, new Date());
  time.title = iso;
  return time;
}

export function imageUrl(value: unknown): string | null {
  const url = httpUrl(value);
  if (!url) return null;
  if (url.startsWith("https:")) return url;
  if (typeof window !== "undefined" && url.startsWith(`${window.location.origin}/`)) return url;
  return null;
}

export function httpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.textContent = label;
  node.addEventListener("click", onClick);
  return node;
}

export function renderPlanCard(
  plan: PlanView,
  actions: {
    editing: boolean;
    members: string[];
    onReject: () => void;
    onEdit: () => void;
    onApprove: () => void;
    onSave: (tasks: Array<{ title: string; assignee: string; estimate: string; depends_on: string }>) => void;
    onCancel: () => void;
    onPause: () => void;
    onOpenTasks: () => void;
  },
): HTMLElement {
  const card = el("div", "card plan");
  const head = el("div", "card-h");
  head.append(el("span", "label-cap", "Plan"));
  head.append(el("span", "ttl trunc", plan.title));
  const executing = plan.status === "executing" || plan.status === "paused" || plan.status === "done";
  const doneCount = plan.items.filter((item) => item.taskStatus === "done").length;
  const pill = el(
    "span",
    `pill ${plan.status === "pending" ? "warn" : plan.status === "rejected" ? "bad" : plan.status === "done" ? "ok" : "accent"}`,
    plan.status === "pending"
      ? "Awaiting approval"
      : plan.status === "executing"
        ? `Executing · ${doneCount} of ${plan.items.length} done`
        : plan.status,
  );
  head.append(pill);
  card.append(head);
  const body = el("div", "card-b");
  const goal = el("div", "goal");
  const label = el("b", "", "Goal — ");
  goal.append(label, document.createTextNode(plan.summary));
  body.append(goal);
  card.append(body);
  if (executing) {
    const bar = el("div", "segbar");
    bar.style.gridTemplateColumns = `repeat(${Math.max(plan.items.length, 1)}, 1fr)`;
    bar.style.padding = "0 12px 8px";
    for (const item of plan.items) {
      const segment = el("i");
      segment.className = item.taskStatus === "done" ? "done" : item.taskStatus === "blocked" ? "blk" : item.taskStatus === "working" ? "run" : "";
      bar.append(segment);
    }
    card.append(bar);
  }
  plan.items.forEach((item, index) => {
    const row = el("div", `ptask${executing ? " exec" : ""}${item.taskStatus === "done" ? " is-done" : ""}${actions.editing ? " editing" : ""}`);
    row.append(executing ? statusGlyph(item.taskStatus) : el("span", "faint", String(item.position)));
    row.append(el("span", "n", item.code));
    if (actions.editing && plan.status === "pending") {
      const title = document.createElement("input");
      title.value = item.title;
      title.dataset.field = "title";
      title.dataset.index = String(index);
      const assignee = document.createElement("select");
      assignee.dataset.field = "assignee";
      assignee.dataset.index = String(index);
      for (const name of actions.members) {
        const option = document.createElement("option");
        option.value = name;
        option.textContent = name;
        if (name === item.assignee) option.selected = true;
        assignee.append(option);
      }
      const estimate = document.createElement("input");
      estimate.value = item.estimate;
      estimate.dataset.field = "estimate";
      estimate.dataset.index = String(index);
      row.append(title, assignee, estimate);
    } else {
      const title = el("span", "t trunc", item.title);
      if (item.dependsOn) {
        const dep = el("span", "dep", item.dependsOn);
        title.append(dep);
      }
      const who = el("span", "asg");
      const working = item.taskStatus === "working";
      who.append(avatarEl({ name: item.assignee, isHuman: false }, 16, { working }), document.createTextNode(item.assignee));
      row.append(title, who);
      if (executing) {
        const prog = el("span", "prog", progressText(item));
        if (item.taskStatus === "blocked") prog.style.color = "var(--warning-text)";
        row.append(prog);
      } else {
        row.append(el("span", "est", item.estimate));
      }
    }
    card.append(row);
  });
  const foot = el("div", "card-f");
  if (plan.status === "pending" && actions.editing) {
    foot.append(el("span", "kv", "Edit tasks, then approve"));
    const spacer = el("span", "sp");
    foot.append(
      spacer,
      button("Cancel", "btn btn-ghost", actions.onCancel),
      button("Save", "btn btn-primary", () => actions.onSave(readEdits(card))),
    );
  } else if (plan.status === "pending") {
    const names = [...new Set(plan.items.map((item) => item.assignee))];
    foot.append(el("span", "kv", `${plan.items.length} tasks · ${names.length} agents`));
    const spacer = el("span", "sp");
    foot.append(
      spacer,
      button("Reject", "btn btn-ghost", actions.onReject),
      button("Edit", "btn btn-secondary", actions.onEdit),
      button("Approve plan", "btn btn-primary", actions.onApprove),
    );
  } else if (plan.status === "rejected") {
    foot.append(el("span", "kv", "Rejected"));
  } else {
    foot.append(decisionLabel(plan.status === "paused" ? "Paused" : "Approved", plan.decidedAt, plan.status));
    const spacer = el("span", "sp");
    foot.append(spacer);
    if (plan.status === "executing" || plan.status === "paused") {
      foot.append(button(plan.status === "paused" ? "Resume" : "Pause all", "btn btn-ghost", actions.onPause));
    }
    foot.append(button("Open in Tasks", "btn btn-secondary", actions.onOpenTasks));
  }
  card.append(foot);
  return card;
}

function readEdits(card: HTMLElement) {
  const rows = new Map<number, { title: string; assignee: string; estimate: string; depends_on: string }>();
  for (const input of card.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-index]")) {
    const index = Number(input.dataset.index);
    const current = rows.get(index) ?? { title: "", assignee: "", estimate: "", depends_on: "" };
    const field = input.dataset.field;
    if (field === "title") current.title = input.value;
    if (field === "assignee") current.assignee = input.value;
    if (field === "estimate") current.estimate = input.value;
    rows.set(index, current);
  }
  return [...rows.entries()].sort((a, b) => a[0] - b[0]).map((entry) => entry[1]);
}

function progressText(item: PlanItemView): string {
  if (item.taskStatus === "done") return item.resultNote ? `Done · ${item.resultNote}` : "Done";
  if (item.taskStatus === "blocked") return item.resultNote || "Blocked";
  if (item.taskStatus === "working") return item.resultNote || "Running";
  if (item.dependsOn) return `Waiting · ${item.dependsOn}`;
  return "Queued";
}

export function renderResultCard(
  result: ResultView,
  actions: { onApprove: () => void; onChanges: () => void; onUndo: () => void; onRerun?: () => void },
): HTMLElement {
  const card = el("div", "card");
  card.append(resultHead(result), resultBody(result), resultFoot(result, actions));
  return card;
}

function resultHead(result: ResultView): HTMLElement {
  const head = el("div", "card-h");
  const payload = result.payload;
  if (result.kind === "pr") {
    head.append(icon("pr", 16));
    head.append(el("span", "trunc", `${text(payload.repo) || "pull request"}${payload.number ? ` #${payload.number}` : ""}`));
    head.append(el("span", "pill neutral", text(payload.state) || "open"));
    const url = httpUrl(payload.url);
    if (url) {
      const link = document.createElement("a");
      link.className = "icon-btn";
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.append(icon("external", 14));
      head.append(el("span", "sp"), link);
    }
  } else if (result.kind === "tests") {
    head.append(icon("flask", 16));
    head.append(el("span", "ttl", "Test results"));
    const meta = [text(payload.runner), text(payload.duration)].filter(Boolean).join(" · ");
    if (meta) head.append(el("span", "mono faint", meta));
    head.append(el("span", "sp"));
    const failed = number(payload.failed);
    if (failed > 0) head.append(el("span", "pill bad", `${failed} failed`));
  } else if (result.kind === "screenshot") {
    head.append(icon("image", 16));
    head.append(el("span", "trunc", text(payload.name) || "Screenshot"));
    const dims = payload.width && payload.height ? `${payload.width}×${payload.height}` : "";
    head.append(el("span", "sp"), el("span", "kv", dims));
  } else if (result.kind === "file") {
    head.append(icon("file", 16));
    head.append(el("span", "trunc", text(payload.name) || "File"));
    head.append(el("span", "sp"), el("span", "kv", [text(payload.size), text(payload.type)].filter(Boolean).join(" · ")));
  } else {
    head.append(icon("file", 16));
    head.append(el("span", "trunc", text(payload.title) || "Note"));
  }
  return head;
}

function resultBody(result: ResultView): HTMLElement {
  const body = el("div", "card-b");
  const payload = result.payload;
  if (result.kind === "pr") {
    body.append(el("div", "pr-title", text(payload.title)));
    const branch = el("div", "branch", [text(payload.branch), text(payload.base)].filter(Boolean).join(" · "));
    body.append(branch);
    const stat = el("div", "diffstat");
    stat.append(el("span", "add", `+${number(payload.additions)}`), el("span", "del", `−${number(payload.deletions)}`));
    const squares = el("span", "dsq");
    const add = number(payload.additions);
    const del = number(payload.deletions);
    const total = Math.max(add + del, 1);
    const addSquares = Math.round((add / total) * 5);
    for (let index = 0; index < 5; index += 1) squares.append(el("i", index < addSquares ? "a" : del > 0 ? "d" : ""));
    stat.append(squares);
    body.append(stat);
    if (payload.checksTotal !== undefined) {
      body.append(el("div", "checks", `${number(payload.checksPassed)}/${number(payload.checksTotal)} checks`));
    }
    const allFiles = Array.isArray(payload.files) ? payload.files : [];
    const files = allFiles.slice(0, 2);
    if (files.length > 0) {
      const list = el("div", "files");
      for (const file of files) {
        if (!file || typeof file !== "object") continue;
        const row = el("div");
        const record = file as Record<string, unknown>;
        row.append(el("span", "p", text(record.path)));
        row.append(el("span", "add", `+${number(record.additions)}`));
        row.append(el("span", "del", `−${number(record.deletions)}`));
        list.append(row);
      }
      if (allFiles.length > 2) list.append(el("div", "p faint", `+${allFiles.length - 2} more files`));
      body.append(list);
    }
  } else if (result.kind === "tests") {
    const passed = number(payload.passed);
    const failed = number(payload.failed);
    const skipped = number(payload.skipped);
    const total = Math.max(passed + failed + skipped, 1);
    const stats = el("div", "tstat");
    stats.append(statBit(String(passed), " passed"), statBit(String(failed), " failed"), statBit(String(skipped), " skipped"));
    body.append(stats);
    const bar = el("div", "tests-bar");
    bar.append(block((passed / total) * 100, "var(--success)"), block((failed / total) * 100, "var(--danger)"), block((skipped / total) * 100, "var(--border-strong)"));
    body.append(bar);
    const failures = Array.isArray(payload.failures) ? payload.failures : [];
    if (failures.length > 0) {
      const box = el("div", "fail");
      for (const failure of failures) {
        if (!failure || typeof failure !== "object") continue;
        const record = failure as Record<string, unknown>;
        const line = el("div", "", `× ${text(record.name)} `);
        if (record.location) line.append(el("span", "loc", text(record.location)));
        box.append(line);
      }
      body.append(box);
    }
    if (payload.note) body.append(el("p", "kv", text(payload.note)));
  } else if (result.kind === "screenshot") {
    const url = imageUrl(payload.url);
    const frame = el("div", "shot");
    frame.style.display = "flex";
    frame.style.alignItems = "center";
    frame.style.justifyContent = "center";
    if (url) {
      const image = document.createElement("img");
      image.src = url;
      image.alt = text(payload.caption) || text(payload.name) || "Screenshot";
      image.style.width = "100%";
      image.style.height = "130px";
      image.style.objectFit = "cover";
      image.referrerPolicy = "no-referrer";
      image.addEventListener("error", () => {
        frame.classList.add("shot-fallback");
        frame.replaceChildren(document.createTextNode("Screenshot unavailable"));
      });
      frame.append(image);
    } else {
      frame.classList.add("shot-fallback");
      frame.textContent = "Screenshot unavailable";
    }
    body.append(frame);
    if (payload.caption) body.append(el("p", "kv", text(payload.caption)));
  } else if (result.kind === "file") {
    const preview = el("div", "preview");
    preview.innerHTML = renderMarkdown(text(payload.preview) || text(payload.name));
    body.append(preview);
    const url = httpUrl(payload.url);
    if (url) {
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.className = "btn btn-secondary btn-sm";
      link.textContent = "Download";
      link.style.marginTop = "8px";
      body.append(link);
    }
  } else {
    const preview = el("div", "preview");
    preview.innerHTML = renderMarkdown(text(payload.body));
    body.append(preview);
  }
  return body;
}

function resultFoot(
  result: ResultView,
  actions: { onApprove: () => void; onChanges: () => void; onUndo: () => void; onRerun?: () => void },
): HTMLElement {
  const foot = el("div", `card-f${result.status === "approved" ? " approved" : ""}`);
  if (result.status === "approved") {
    const approved = el("span", "");
    approved.append(document.createTextNode("Approved by you"));
    if (result.decidedAt) {
      approved.append(document.createTextNode(" · "));
      approved.append(timeEl(result.decidedAt));
    }
    foot.append(approved);
    foot.append(el("span", "sp"), button("Undo", "btn btn-ghost btn-sm", actions.onUndo));
    return foot;
  }
  if (result.status === "changes_requested") {
    foot.append(el("span", "", result.decisionNote ? `Changes requested · ${result.decisionNote}` : "Changes requested"));
    return foot;
  }
  if (result.kind === "tests" && number(result.payload.failed) > 0 && actions.onRerun) {
    const rerun = button("Re-run failed", "btn btn-ghost btn-sm", actions.onRerun);
    rerun.prepend(icon("refresh", 14));
    foot.append(rerun);
  }
  foot.append(el("span", "sp"));
  foot.append(
    button("Request changes", "btn btn-ghost btn-sm", actions.onChanges),
    button("Approve", "btn btn-primary btn-sm", actions.onApprove),
  );
  return foot;
}

function statBit(value: string, label: string): HTMLElement {
  const node = el("span");
  node.append(el("b", "", value), document.createTextNode(label));
  return node;
}

function block(width: number, color: string): HTMLElement {
  const node = el("i");
  node.style.width = `${width}%`;
  node.style.background = color;
  return node;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
