import {
  App,
  ItemView,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
  MarkdownView,
} from "obsidian";

// ─── Constants ────────────────────────────────────────────────────────────────

const VIEW_TYPE = "todo-dashboard";
const PRIORITY_CYCLE: Array<TodoTask["priority"]> = [null, "high", "medium", "low"];
const PRIORITY_EMOJI: Record<string, string> = { high: "⏫", medium: "🔼", low: "🔽" };
const PRIORITY_LABEL: Record<string, string> = { high: "high", medium: "med", low: "low" };

// ─── Types ────────────────────────────────────────────────────────────────────

interface TodoTask {
  text: string;
  done: boolean;
  priority: "high" | "medium" | "low" | null;
  due: string | null;
  tags: string[];
  lineNumber: number;
}

interface TodoFile {
  file: TFile;
  tasks: TodoTask[];
}

interface TodoDashboardSettings {
  includeFolders: string[];
  excludeFolders: string[];
  showCompleted: boolean;
  refreshInterval: number;
  addTaskPosition: "top" | "bottom";
}

const DEFAULT_SETTINGS: TodoDashboardSettings = {
  includeFolders: [],
  excludeFolders: ["templates", "archive", ".trash"],
  showCompleted: true,
  refreshInterval: 30,
  addTaskPosition: "bottom",
};

// ─── Task Parser ──────────────────────────────────────────────────────────────

function parseTasksFromContent(content: string): TodoTask[] {
  const tasks: TodoTask[] = [];
  const lines = content.split("\n");
  const taskRegex = /^(\s*)-\s+\[( |x|X)\]\s+(.+)$/;

  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    if (lineText === undefined) continue;
    const match = lineText.match(taskRegex);
    if (!match) continue;

    const done = match[2]!.toLowerCase() === "x";
    const rawText = match[3]!;

    let due: string | null = null;
    for (const re of [/📅\s*(\d{4}-\d{2}-\d{2})/, /\[due::\s*(\d{4}-\d{2}-\d{2})\]/i, /due::\s*(\d{4}-\d{2}-\d{2})/i]) {
      const m = rawText.match(re);
      if (m) { due = m[1] ?? null; break; }
    }

    let priority: TodoTask["priority"] = null;
    if (/🔺|⏫/.test(rawText)) priority = "high";
    else if (/🔼/.test(rawText)) priority = "medium";
    else if (/🔽|⏬/.test(rawText)) priority = "low";
    if (!priority) {
      const pm = rawText.match(/\[priority::\s*(high|medium|low)\]/i);
      if (pm) priority = pm[1]!.toLowerCase() as TodoTask["priority"];
    }

    const tags = rawText.match(/#[\w/-]+/g) ?? [];

    const cleanText = rawText
      .replace(/📅\s*\d{4}-\d{2}-\d{2}/g, "")
      .replace(/\[due::\s*\d{4}-\d{2}-\d{2}\]/gi, "")
      .replace(/due::\s*\d{4}-\d{2}-\d{2}/gi, "")
      .replace(/\[priority::\s*(high|medium|low)\]/gi, "")
      .replace(/🔺|⏫|🔼|🔽|⏬/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();

    tasks.push({ text: cleanText, done, priority, due, tags, lineNumber: i });
  }

  return tasks;
}

// ─── Dashboard View ───────────────────────────────────────────────────────────

class TodoDashboardView extends ItemView {
  plugin: TodoDashboardPlugin;
  private refreshTimer: number | null = null;
  private searchDebounce: number | null = null;

  private activeFilter: string = "all";
  private searchQuery: string = "";
  private openFiles: Set<string> = new Set();
  private allCollapsed: boolean = false;

  private todoFiles: TodoFile[] = [];
  private resizeObserver: ResizeObserver | null = null;

  private fileListEl: HTMLElement | null = null;
  private statEls: Record<string, HTMLElement> = {};
  private showCompletedBtn: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: TodoDashboardPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "Todo dashboard"; }
  getIcon() { return "check-square"; }

  async onOpen() {
    this.scheduleRefresh();
    this.buildShell();
    await this.reloadAndRender();

    this.registerEvent(this.app.vault.on("modify", () => this.reloadAndRender()));
    this.registerEvent(this.app.vault.on("create", () => this.reloadAndRender()));
    this.registerEvent(this.app.vault.on("delete", () => this.reloadAndRender()));
    this.registerEvent(this.app.vault.on("rename", () => this.reloadAndRender()));

    this.resizeObserver = new ResizeObserver(() => this.applyLayoutClass());
    this.resizeObserver.observe(this.containerEl);
  }

  async onClose(): Promise<void> {
    if (this.refreshTimer) window.clearInterval(this.refreshTimer);
    if (this.searchDebounce) window.clearTimeout(this.searchDebounce);
    if (this.resizeObserver) this.resizeObserver.disconnect();
  }

  private applyLayoutClass() {
    const container = this.containerEl.children[1] as HTMLElement;
    if (!container) return;
    container.toggleClass("td-fullpage", container.clientWidth >= 700);
  }

  private updateCompletedBtn() {
    if (!this.showCompletedBtn) return;
    this.showCompletedBtn.textContent = this.plugin.settings.showCompleted
      ? "Hide completed"
      : "Show completed";
  }

  private scheduleRefresh() {
    if (this.refreshTimer) window.clearInterval(this.refreshTimer);
    const interval = this.plugin.settings.refreshInterval;
    if (interval > 0) {
      this.refreshTimer = window.setInterval(() => { void this.reloadAndRender(); }, interval * 1000);
    }
  }

  // ── Shell (built once on open, never torn down) ──────────────────────────────

  private buildShell() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("todo-dashboard-container");
    this.applyLayoutClass();

    const header = container.createDiv("td-header");
    const titleRow = header.createDiv("td-title-row");
    titleRow.createEl("h2", { text: "Todo dashboard", cls: "td-title" });

    const collapseBtn = titleRow.createEl("button", { text: "Collapse all", cls: "td-collapse-btn" });
    collapseBtn.addEventListener("click", () => {
      this.allCollapsed = !this.allCollapsed;
      if (this.allCollapsed) {
        this.openFiles.clear();
        collapseBtn.textContent = "Expand all";
      } else {
        this.todoFiles.forEach((tf) => this.openFiles.add(tf.file.path));
        collapseBtn.textContent = "Collapse all";
      }
      this.renderFileBlocks();
    });

    // Show/hide completed — live toggle, syncs with settings
    const completedBtn = titleRow.createEl("button", { cls: "td-collapse-btn" });
    this.showCompletedBtn = completedBtn;
    this.updateCompletedBtn();
    completedBtn.addEventListener("click", () => {
      this.plugin.settings.showCompleted = !this.plugin.settings.showCompleted;
      void this.plugin.saveSettings().then(() => {
        this.updateCompletedBtn();
        this.renderFileBlocks();
      });
    });

    const statsRow = header.createDiv("td-stats-row");
    this.statEls = {};
    for (const [key, label, mod] of [
      ["open", "Open tasks", "accent"],
      ["files", "Files with todos", ""],
      ["overdue", "Overdue", "danger"],
      ["done", "Completed", "success"],
    ] as [string, string, string][]) {
      const card = statsRow.createDiv("td-stat-card");
      card.createDiv({ text: label, cls: "td-stat-label" });
      const val = card.createDiv({ text: "—", cls: "td-stat-value" });
      if (mod) val.addClass(`td-stat-${mod}`);
      this.statEls[key] = val;
    }

    const filterRow = header.createDiv("td-filter-row");
    filterRow.createSpan({ text: "Priority:", cls: "td-filter-label" });

    for (const { label, value } of [
      { label: "All", value: "all" },
      { label: "High", value: "high" },
      { label: "Medium", value: "medium" },
      { label: "Low", value: "low" },
    ]) {
      const pill = filterRow.createEl("button", { text: label, cls: "td-pill" });
      if (value === "high") pill.addClass("td-pill-high");
      if (value === "medium") pill.addClass("td-pill-medium");
      if (value === this.activeFilter) pill.addClass("td-pill-active");
      pill.addEventListener("click", () => {
        this.activeFilter = value;
        filterRow.querySelectorAll(".td-pill").forEach((p) => (p as HTMLElement).removeClass("td-pill-active"));
        pill.addClass("td-pill-active");
        this.renderFileBlocks();
      });
    }

    // Search — permanent DOM node; never destroyed so focus is never lost
    const searchWrap = filterRow.createDiv("td-search-wrap");
    const searchInput = searchWrap.createEl("input", {
      type: "text",
      placeholder: "Search tasks…",
      cls: "td-search",
    });
    searchInput.value = this.searchQuery;

    searchInput.addEventListener("input", () => {
      this.searchQuery = searchInput.value;
      if (this.searchDebounce) window.clearTimeout(this.searchDebounce);
      this.searchDebounce = window.setTimeout(() => this.renderFileBlocks(), 150);
    });

    this.fileListEl = container.createDiv("td-files-list");
  }

  // ── Data ─────────────────────────────────────────────────────────────────────

  private async reloadAndRender() {
    this.todoFiles = await this.loadTodoFiles();
    if (this.openFiles.size === 0 && !this.allCollapsed) {
      this.todoFiles.forEach((tf) => this.openFiles.add(tf.file.path));
    }
    this.updateStats();
    this.renderFileBlocks();
  }

  private updateStats() {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    let open = 0, overdue = 0, done = 0;
    this.todoFiles.forEach(({ tasks }) => tasks.forEach((t) => {
      if (t.done) { done++; return; }
      open++;
      if (t.due && new Date(t.due) < today) overdue++;
    }));
    this.statEls["open"]!.textContent = String(open);
    this.statEls["files"]!.textContent = String(this.todoFiles.filter((f) => f.tasks.some((t) => !t.done)).length);
    this.statEls["overdue"]!.textContent = String(overdue);
    this.statEls["done"]!.textContent = String(done);
  }

  // ── File blocks (re-rendered on filter/search/vault changes) ─────────────────

  private renderFileBlocks() {
    if (!this.fileListEl) return;
    this.fileListEl.empty();

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const q = this.searchQuery.toLowerCase();
    let anyVisible = false;

    for (const { file, tasks } of this.todoFiles) {
      let filtered = [...tasks];
      if (this.activeFilter !== "all") filtered = filtered.filter((t) => t.priority === this.activeFilter);
      if (q) filtered = filtered.filter((t) => t.text.toLowerCase().includes(q) || t.tags.some((tg) => tg.toLowerCase().includes(q)));
      if (!this.plugin.settings.showCompleted) filtered = filtered.filter((t) => !t.done);
      if (filtered.length === 0) continue;

      anyVisible = true;
      const openCount = filtered.filter((t) => !t.done).length;
      const isOpen = this.openFiles.has(file.path);

      const block = this.fileListEl.createDiv("td-file-block");
      if (isOpen) block.addClass("td-file-open");

      // Header
      const fileHeader = block.createDiv("td-file-header");
      fileHeader.addEventListener("click", () => {
        if (this.openFiles.has(file.path)) this.openFiles.delete(file.path);
        else this.openFiles.add(file.path);
        this.renderFileBlocks();
      });

      const left = fileHeader.createDiv("td-file-header-left");
      const folderPath = file.parent?.path ?? "";
      if (folderPath && folderPath !== "/") left.createSpan({ text: folderPath + "/", cls: "td-file-path" });
      left.createSpan({ text: file.basename, cls: "td-file-name" });

      const right = fileHeader.createDiv("td-file-header-right");
      right.createSpan({ text: String(openCount), cls: "td-badge" });
      const chevron = right.createEl("span", { cls: "td-chevron" });
      const chevronSvg = chevron.createSvg("svg", { attr: { width: "14", height: "14", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2" } });
      chevronSvg.createSvg("polyline", { attr: { points: "9 18 15 12 9 6" } });
      const openLink = right.createEl("span", { cls: "td-open-file", title: "Open file" });
      const openSvg = openLink.createSvg("svg", { attr: { width: "12", height: "12", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2" } });
      openSvg.createSvg("path", { attr: { d: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" } });
      openSvg.createSvg("polyline", { attr: { points: "15 3 21 3 21 9" } });
      openSvg.createSvg("line", { attr: { x1: "10", y1: "14", x2: "21", y2: "3" } });
      openLink.addEventListener("click", (e) => { e.stopPropagation(); void this.app.workspace.getLeaf(false).openFile(file); });

      if (!isOpen) continue;

      // Body
      const body = block.createDiv("td-file-body");

      // Add form at top if configured
      if (this.plugin.settings.addTaskPosition === "top") {
        this.renderAddForm(body, file);
        body.createDiv("td-add-divider");
      }

      for (const task of filtered) {
        const row = body.createDiv("td-task-row");
        if (task.done) row.addClass("td-task-done");

        const cb = row.createEl("input", { type: "checkbox", cls: "td-checkbox" });
        cb.checked = task.done;
        cb.addEventListener("change", () => { void this.toggleTask(file, task.lineNumber, task.done); });

        const taskContent = row.createDiv("td-task-content");
        const taskText = taskContent.createDiv({ cls: "td-task-text" });
        taskText.setText(task.text);
        taskText.addEventListener("click", () => { void this.openFileAtLine(file, task.lineNumber); });

        if (task.tags.length > 0) {
          const tagsRow = taskContent.createDiv("td-tags-row");
          task.tags.forEach((tag) => tagsRow.createSpan({ text: tag, cls: "td-tag" }));
        }

        const meta = row.createDiv("td-task-meta");

        if (task.due) {
          const overdue = !task.done && new Date(task.due) < today;
          meta.createSpan({
            text: (overdue ? "⚠ " : "") + formatDate(task.due),
            cls: "td-due" + (overdue ? " td-due-overdue" : ""),
          });
        }

        // Priority — cycle button for open tasks, static badge for done
        if (!task.done) {
          const priBtn = meta.createEl("button", { cls: "td-priority-btn" });
          this.applyPriorityBtn(priBtn, task.priority);
          priBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            const next = PRIORITY_CYCLE[(PRIORITY_CYCLE.indexOf(task.priority) + 1) % PRIORITY_CYCLE.length]!;
            void this.setPriorityOnTask(file, task.lineNumber, task.priority, next);
            // Optimistic update — vault event will confirm
            task.priority = next;
            this.applyPriorityBtn(priBtn, next);
          });
        } else if (task.priority) {
          meta.createSpan({ text: task.priority, cls: `td-priority td-priority-${task.priority}` });
        }
      }

      // Add form at bottom (default)
      if (this.plugin.settings.addTaskPosition === "bottom") {
        this.renderAddForm(body, file);
      }
    }

    if (!anyVisible) {
      this.fileListEl.createDiv({ text: "No tasks match this filter.", cls: "td-empty" });
    }
  }

  private applyPriorityBtn(btn: HTMLElement, priority: TodoTask["priority"]) {
    btn.removeClass("td-pri-none", "td-pri-high", "td-pri-medium", "td-pri-low");
    if (priority) {
      btn.addClass(`td-pri-${priority}`);
      btn.textContent = `${PRIORITY_EMOJI[priority]} ${PRIORITY_LABEL[priority]}`;
      btn.setAttribute("title", `Priority: ${priority} — click to cycle`);
    } else {
      btn.addClass("td-pri-none");
      btn.textContent = "· · ·";
      btn.setAttribute("title", "No priority — click to assign");
    }
  }

  private renderAddForm(body: HTMLElement, file: TFile) {
    const addRow = body.createDiv("td-add-row");
    const addToggle = addRow.createEl("button", { cls: "td-add-toggle" });
    const addSvg = addToggle.createSvg("svg", { attr: { width: "13", height: "13", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2.5" } });
    addSvg.createSvg("line", { attr: { x1: "12", y1: "5", x2: "12", y2: "19" } });
    addSvg.createSvg("line", { attr: { x1: "5", y1: "12", x2: "19", y2: "12" } });
    addToggle.appendText(" Add task");

    const addForm = addRow.createDiv("td-add-form td-add-form-hidden");
    const textInput = addForm.createEl("input", { type: "text", placeholder: "New task…", cls: "td-add-text" });
    const addControls = addForm.createDiv("td-add-controls");

    const prioritySelect = addControls.createEl("select", { cls: "td-add-select" });
    [{ value: "", label: "No priority" }, { value: "high", label: "⏫ High" }, { value: "medium", label: "🔼 Medium" }, { value: "low", label: "🔽 Low" }]
      .forEach(({ value, label }) => { const o = prioritySelect.createEl("option", { text: label }); o.value = value; });

    const dueInput = addControls.createEl("input", { type: "date", cls: "td-add-date" });
    const submitBtn = addControls.createEl("button", { text: "Add", cls: "td-add-submit" });
    const cancelBtn = addControls.createEl("button", { text: "Cancel", cls: "td-add-cancel" });

    const showForm = () => { addToggle.addClass("td-add-toggle-active"); addForm.removeClass("td-add-form-hidden"); textInput.focus(); };
    const hideForm = () => { addToggle.removeClass("td-add-toggle-active"); addForm.addClass("td-add-form-hidden"); textInput.value = ""; prioritySelect.value = ""; dueInput.value = ""; };

    addToggle.addEventListener("click", (e) => { e.stopPropagation(); if (addForm.hasClass("td-add-form-hidden")) { showForm(); } else { hideForm(); } });
    cancelBtn.addEventListener("click", (e) => { e.stopPropagation(); hideForm(); });

    const doSubmit = async () => {
      const text = textInput.value.trim();
      if (!text) { textInput.focus(); return; }
      submitBtn.disabled = true; submitBtn.textContent = "Adding…";
      await this.addTaskToFile(file, text, (prioritySelect.value || null) as "high" | "medium" | "low" | null, dueInput.value || null);
      hideForm();
    };
    submitBtn.addEventListener("click", (e) => { e.stopPropagation(); void doSubmit(); });
    textInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); void doSubmit(); } if (e.key === "Escape") hideForm(); });
  }

  // ── File writers ──────────────────────────────────────────────────────────────

  private async toggleTask(file: TFile, lineNumber: number, currentDone: boolean) {
    const content = await this.app.vault.read(file);
    const lines = content.split("\n");
    const currentLine = lines[lineNumber];
    if (currentLine === undefined) return;
    lines[lineNumber] = currentDone
      ? currentLine.replace(/\[x\]/i, "[ ]")
      : currentLine.replace(/\[ \]/, "[x]");
    await this.app.vault.modify(file, lines.join("\n"));
  }

  private async setPriorityOnTask(file: TFile, lineNumber: number, _old: TodoTask["priority"], next: TodoTask["priority"]) {
    const content = await this.app.vault.read(file);
    const lines = content.split("\n");
    let line = lines[lineNumber];
    if (line === undefined) return;

    // Strip all existing priority markers
    line = line.replace(/\s*[🔺⏫🔼🔽⏬]/gu, "");
    line = line.replace(/\s*\[priority::\s*(high|medium|low)\]/gi, "");
    line = line.replace(/\s{2,}/g, " ").trimEnd();

    if (next) {
      const emoji = PRIORITY_EMOJI[next];
      // Insert before due date if present, otherwise append
      line = line.includes("📅") ? line.replace(/(📅)/, `${emoji} $1`) : `${line} ${emoji}`;
    }

    lines[lineNumber] = line;
    await this.app.vault.modify(file, lines.join("\n"));
  }

  private async addTaskToFile(file: TFile, text: string, priority: "high" | "medium" | "low" | null, due: string | null) {
    const content = await this.app.vault.read(file);
    const lines = content.split("\n");
    const taskLine = `- [ ] ${text}${priority ? " " + PRIORITY_EMOJI[priority] : ""}${due ? " 📅 " + due : ""}`;

    let insertAt = lines.length;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^\s*-\s+\[[ xX]\]/.test(lines[i]!)) { insertAt = i + 1; break; }
    }
    lines.splice(insertAt, 0, taskLine);
    while (lines.length > 1 && lines[lines.length - 1] === "" && lines[lines.length - 2] === "") lines.pop();
    await this.app.vault.modify(file, lines.join("\n"));
  }

  // ── Navigation ────────────────────────────────────────────────────────────────

  private async openFileAtLine(file: TFile, lineNumber: number) {
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);
    const view = leaf.view;
    if (view instanceof MarkdownView) {
      view.editor.setCursor({ line: lineNumber, ch: 0 });
      view.editor.scrollIntoView({ from: { line: lineNumber, ch: 0 }, to: { line: lineNumber, ch: 0 } }, true);
    }
  }

  // ── Data loading ──────────────────────────────────────────────────────────────

  private async loadTodoFiles(): Promise<TodoFile[]> {
    const { includeFolders, excludeFolders } = this.plugin.settings;
    const results: TodoFile[] = [];

    for (const file of this.app.vault.getMarkdownFiles()) {
      const pathLower = file.path.toLowerCase();
      if (excludeFolders.some((f) => pathLower.startsWith(f.toLowerCase() + "/") || pathLower === f.toLowerCase())) continue;
      if (includeFolders.length > 0 && !includeFolders.some((f) => pathLower.startsWith(f.toLowerCase() + "/"))) continue;
      const tasks = parseTasksFromContent(await this.app.vault.cachedRead(file));
      if (tasks.length === 0) continue;
      results.push({ file, tasks });
    }

    results.sort((a, b) => b.tasks.filter((t) => !t.done).length - a.tasks.filter((t) => !t.done).length);
    return results;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────

class TodoDashboardSettingTab extends PluginSettingTab {
  plugin: TodoDashboardPlugin;

  constructor(app: App, plugin: TodoDashboardPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();


    new Setting(containerEl)
      .setName("Include folders")
      .setDesc("Comma-separated list of folders to scan. Leave empty to scan the entire vault.")
      .addText((text) =>
        text.setPlaceholder("Projects, work, personal")
          .setValue(this.plugin.settings.includeFolders.join(", "))
          .onChange(async (value) => {
            this.plugin.settings.includeFolders = value.split(",").map((s) => s.trim()).filter(Boolean);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Exclude folders")
      .setDesc("Comma-separated list of folders to ignore.")
      .addText((text) =>
        text.setPlaceholder("Templates, archive")
          .setValue(this.plugin.settings.excludeFolders.join(", "))
          .onChange(async (value) => {
            this.plugin.settings.excludeFolders = value.split(",").map((s) => s.trim()).filter(Boolean);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Show completed tasks")
      .setDesc("Display completed tasks (greyed out) alongside open ones. Can also be toggled live from the dashboard header.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showCompleted)
          .onChange(async (value) => { this.plugin.settings.showCompleted = value; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName("Add task position")
      .setDesc("Where the 'add task' form appears inside each file block.")
      .addDropdown((drop) =>
        drop
          .addOption("bottom", "Bottom of list")
          .addOption("top", "Top of list")
          .setValue(this.plugin.settings.addTaskPosition)
          .onChange(async (value) => {
            this.plugin.settings.addTaskPosition = value as "top" | "bottom";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Auto-refresh interval (seconds)")
      .setDesc("How often to re-scan the vault. Set to 0 to disable.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.refreshInterval))
          .onChange(async (value) => {
            const n = parseInt(value);
            if (!isNaN(n) && n >= 0) { this.plugin.settings.refreshInterval = n; await this.plugin.saveSettings(); }
          })
      );
  }
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default class TodoDashboardPlugin extends Plugin {
  settings: TodoDashboardSettings;

  async onload() {
    await this.loadSettings();
    this.registerView(VIEW_TYPE, (leaf) => new TodoDashboardView(leaf, this));
    this.addRibbonIcon("check-square", "Todo dashboard (sidebar)", () => this.openSidebar());
    this.addCommand({ id: "open-sidebar", name: "Open in sidebar", callback: () => this.openSidebar() });
    this.addCommand({ id: "open-fullpage", name: "Open as full page", callback: () => this.openFullPage() });
    this.addSettingTab(new TodoDashboardSettingTab(this.app, this));
  }

  onunload() {
    // Obsidian handles leaf lifecycle on unload
  }

  async openSidebar() {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (existing) { void workspace.revealLeaf(existing); return; }
    const leaf = workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    void workspace.revealLeaf(leaf);
  }

  async openFullPage() {
    const { workspace } = this.app;
    workspace.detachLeavesOfType(VIEW_TYPE);
    const leaf = workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    void workspace.revealLeaf(leaf);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()) as TodoDashboardSettings;
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}