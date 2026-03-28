# Todo Dashboard — Obsidian Plugin

A custom Obsidian plugin that shows all your `- [ ]` todo tasks grouped by source file, in collapsible vertical panels.

If you're anything like me, you obsidian vault is filled with TODO files in plenty of different folders. I love making TODOs, they help me see a larger picture of what I'm working on, and I'm not affraid of loosing thoughts or ideas because I can easily jot them down in these todo files.

The problem is when you have so many TODO files everywhere, it's hard to keep track of all the tasks you have at hand. Furthermore a TODO file in a folder can easily be forgotten and lost in the void of the vault.

This simple plugin helps me create a dashboard, and see all the different TODO files inside my vault, and get a better idea of the tasks I have written down for myself and in what context.
---

## Features

- **File-centric view** — one collapsible panel per `.md` file that contains tasks
- **Live task toggling** — check/uncheck tasks directly from the dashboard; the source file is updated immediately
- **Click to navigate** — click any task text to jump to that line in the source file
- **Priority support** — reads Tasks plugin emoji (`⏫ 🔼 🔽`) or inline fields `[priority:: high]`
- **Due dates** — reads `📅 2026-03-28` (Tasks plugin) or `[due:: 2026-03-28]` (Dataview), highlights overdue items
- **Tags** — displays `#tags` found in task text
- **Filtering** — filter by priority (all / high / medium / low)
- **Search** — full-text search across task text and tags
- **Stats bar** — open tasks, files with todos, overdue count, total completed
- **Auto-refresh** — configurable interval (default 30s), also re-renders on any vault change
- **Settings** — include/exclude folders, show/hide completed, refresh interval

---

## Installation (manual)

This plugin is not on the community store. Install it manually:

### Option A — build from source (recommended)

```bash
# 1. Clone or copy this folder anywhere
cd todo-dashboard

# 2. Install dependencies
npm install

# 3. Build
npm run build
# → produces main.js in the same folder
```

Then copy the three required files into your vault's plugin folder:

```bash
# Replace <YourVault> with the actual path
VAULT=~/<YourVault>
PLUGIN=$VAULT/.obsidian/plugins/todo-dashboard

mkdir -p $PLUGIN
cp main.js manifest.json styles.css $PLUGIN
```
---

## Enabling the plugin

1. Open Obsidian → **Settings → Community plugins**
2. Make sure "Restricted mode" is **off**
3. Find **Todo dashboard** in the installed plugins list and toggle it on
4. A checkbox icon appears in the left ribbon — click it to open the dashboard
5. Or use **Cmd/Ctrl+P → "Open todo dashboard"**

---

## Task format support

The parser reads standard Obsidian markdown checkboxes:

```markdown
- [ ] An open task
- [x] A completed task
```

### Priority

| Format | Result |
|--------|--------|
| `🔺` or `⏫` in task text | high |
| `🔼` in task text | medium |
| `🔽` or `⏬` in task text | low |
| `[priority:: high]` inline field | high |

### Due date

| Format | Example |
|--------|---------|
| Tasks plugin emoji | `📅 2026-03-28` |
| Dataview bracket | `[due:: 2026-03-28]` |
| Dataview inline | `due:: 2026-03-28` |

### Example task using Tasks plugin format

```markdown
- [ ] Review architect's floor plan revision ⏫ 📅 2026-03-25 #review
```

---

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Include folders | (empty = entire vault) | Comma-separated folders to scan |
| Exclude folders | `templates, archive, .trash` | Folders to skip |
| Show completed tasks | on | Show `[x]` tasks (greyed out) |
| Auto-refresh interval | 30s | Re-scan interval in seconds (0 = disabled) |
