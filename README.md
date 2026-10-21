# Dev Loop

Dev Loop помогает подготовить задачи по макетам, внести изменения в код и проверить результат. У плагина восемь навыков: каждый отвечает за понятное действие. Можно выбрать навык в меню или описать задачу обычными словами.

Начни с **help — «Помощь по Dev Loop»**: он объяснит, какой навык выбрать и что понадобится. [Подробное руководство](skills/help/references/guide.md) описывает весь процесс, каждый навык, кнопки, настройку и продолжение после перерыва.

| Команда навыка | Название в меню | Что делает |
|---|---|---|
| `start-task T-10` или описание | Выполнить задачу | Бизнес-ревью, техническое решение, тест-кейсы QA от Codex, код, ревью без PR и было / стало на симуляторе; отчёт с кнопкой Dev Loop для нового круга по комментарию |
| `sim-verify-task T-10`, описание или `PR 2` | Проверить задачу до и после | Проверяет нужные сценарии по условиям задачи, описанию или PR |
| `close-threads PR 2` | Закрыть все треды | Проверяет код PR, разбирает замечания (спорные — обсуждением ролей), исправляет, сразу отвечает в треды и закрывает их |
| `debate` | Спор | Спор по любой теме: роли под тему спорят с доказательствами, вердикт с особыми мнениями; число спорщиков, раундов и объём можно задать. Его же использует `close-threads` для спорных замечаний |
| `filter-design` | Фильтр дизайна | «Проверь с дизайном» или «запушь в дизайн»: страница сравнения с текущими экранами и проверками; кнопки создают задачи Linear (в найденной или новой задаче) и переносят макет в проект дизайна с PR |
| `check-bug TASK-12` или описание | Проверить баг | Воспроизводит задачу на симуляторе, скриншот каждого шага и вердикт: баг, не баг, не воспроизводится или нужны данные, плюс насколько бизнес-логика задачи сходится с мобилкой — в HTML-отчёте |
| `match-design` + скриншот | Сверить с дизайном | Находит экран (или его часть) со скриншота мобилки в workbench, сравнивает рядом / наложением / картой отличий перечисляет различия и сверяет бизнес-логику экрана с мобилкой |
| `help` | Помощь по Dev Loop | Объясняет работу плагина и помогает выбрать действие |

Примеры: `start-task Добавь сохранение имени`, `sim-verify-task T-10 T-11`, `sim-verify-task PR 2`, `close-threads PR 2`. Номер PR относится к текущему проекту; вместо номера можно передать ссылку. Для задачи, заданной текстом, Linear не нужен. В Codex можно выбрать `$help`, в Claude Code — `/dev-loop:help`. [Старые и новые названия](skills/help/references/guide.md#migration).

[Privacy](PRIVACY.md) · [Support](SUPPORT.md)

Далее — техническая справка по установке и устройству плагина. Пользовательское руководство на русском находится по ссылке выше.

## Requirements

- Local desktop execution on macOS or Linux, Python 3.10+, Bash, and Git. Native Windows is not supported by the current POSIX process locks and shell helpers.
- Pillow and NumPy for image comparison and screenshot validation.
- For iOS: macOS with Xcode, a booted Simulator, and `idb` for taps. For Android: Android SDK, `adb`, and a booted emulator. Explicitly select `SIM_PLATFORM` and `SIM_DEVICE` when more than one device is available.
- For GitHub: GitHub CLI (`gh`) signed in to an account authorized for the selected repository. Use its normal local sign-in; do not paste credentials into a chat or report.
- For independent review: a configured Codex CLI or an authorized independent reviewer supported by the host.
- For the handoff skills: Node.js 22+, Google Chrome (rendering and token checks), read access to the team's design repository on GitHub, and `LINEAR_API_KEY` or a Linear MCP connection for creating tasks. The first run sets up the design repository (full or light mode).

Installation does not install these dependencies or start a background service. Use the selected app project's existing build procedure. The optional `sim.sh build` helper requires an executable `scripts/sim-build.sh` in that app project that builds and installs the app on the selected device.

## Install and start

For a public release, install Dev Loop from the supported desktop plugin directory after it has been approved and published. This source tree is a release candidate; it is not evidence of directory approval.

Install from the public source repository:

```bash
codex plugin marketplace add ChepelevIgor/dev-loop
codex plugin add dev-loop@local-dev-loop
```

For local development, you can also use `codex plugin marketplace add .` from a cloned source folder.

Create a Python environment in a writable location and install dependencies from this package:

```bash
python3 -m venv /absolute/path/to/dev-loop-venv
/absolute/path/to/dev-loop-venv/bin/python -m pip install -r /absolute/path/to/dev-loop/requirements.txt
```

Open a new local chat in the target application's project, select `start-task` if available, or ask to use Dev Loop. Tell the agent the environment's Python path. Shell simulator helpers call `python3`, so activate the same environment in their terminal session.

Example requests:

- “Use Dev Loop to check this change against its acceptance criteria and save a local report.”
- “close-threads PR 2: review this PR, settle every remark, reply and resolve the threads.”
- “Resume the queued Dev Loop task and show which checks still need evidence.”

An existing PR review does not require starting a new implementation or publishing another PR. The agent follows the scope of the request.

## Skills and state

The skill list above uses the current command names. See the [guide](skills/help/references/guide.md) for inputs, examples and results for each skill.

Task state lives in the target project's `.devloop/`. Keep it out of source commits: screenshots, source excerpts and logs can contain private data. SQLite is authoritative; JSON queue files and `state.json` are exported views. Operate transitions through the CLI rather than moving files manually. Read the [runtime contract](skills/start-task/references/runtime.md) for task setup, evidence formats and recovery.

The interactive agent performs each stage by default. The optional bounded runner can execute explicitly configured local workers. It does not provide a universal model backend or app builder. No worker configuration means no automatic stage execution. Test fixture workers are not production executors.

## Design handoff

`filter-design` starts from what the designer made (HTML files, folders of variants, Claude artifact links). Every design gets an id (D1, D2, …) and a target screen; designs of the same screen are variants. A local page opens in the browser with each design next to the current screen, the filter results and a choice: take, rework (with a comment) or skip. The agent splits the work into tasks by the team's templates (variants of one screen are one task, client and backend are separate tasks) and the plan is validated before the page is shown. «Create Linear tasks» creates each task once, uploads its screenshots into it and attaches the page; a task the designer named, or an existing task picked on the page from a Linear search, receives the designs as a comment instead. «Push to design» does the same and then builds each taken design in the design repository on its own `design/…` branch, with before/after shots and checks, and opens a PR that is attached to the Linear task (its status is left alone); it needs the full mode and one taken variant per screen. «Check with design» and «push to design» both start with this page. A Claude artifact is created only on request, from the same page. Decisions from an older page version are refused.

The first run checks the computer and sets up the design repository: full mode clones it with its dependencies (current-screen shots and moving designs into the design repository work); light mode downloads only the theme, screens and task rules and reads mobile routes from GitHub. Team repositories are asked once and kept in `~/.handoff.json`; nothing team-specific ships with the plugin. A local mobile checkout must be explicitly configured through `mobileClone` in the design repo's `.workbench-cache/stand.local.json`, `mobile` in `~/.handoff.json`, or `HANDOFF_MOBILE` (in that order). No sibling project is selected automatically. Designs and their reworks are copies; the designer's files and the design repository's checkout are only read.

Without a Linear API key, task lookup and publication try the official Linear MCP in Claude Code. An existing connection is reused; otherwise the server is registered with local project scope, without credentials in the repository. Finish OAuth through Claude’s `/mcp` menu and verify read access before continuing. Pending publication keeps its preview and explicitly reports that nothing was published. See the [connection workflow](skills/filter-design/references/linear-connection.md).

Linear publication has one local owner per batch. A concurrent invocation exits with a retry message. Successful issue/comment writes are checkpointed before attachments, so an attachment failure can be retried without posting the content again. Recovery also searches existing comments across all pages. After a forced termination, inspect the owner recorded in `state/batches/<batch>/linear.lock` and confirm it has stopped before removing that lock; do not remove it from a running process or discard `linear-progress.json`.

Approval versions include checks and the bytes of the displayed screenshots. The browser uses a separate rendered-page revision to refresh created-task links without changing the approved version. Rebuild pages after changing checks or images. Task IDs must be unique within a plan, and `main` is reserved as the baseline copy when moving a design into code.

## Local report

The default output is an ordinary HTML page for each task, created before tests run and updated as evidence arrives. The agent links or presents that file in the original task conversation. A local `report-page.json` records the page's task ID and current file hash. This local association does not automatically post a file to an external issue tracker.

After the agent saves `task.json` (run data is optional), from the target project:

```bash
PLUGIN_DIR=/absolute/path/to/dev-loop
PYTHON=/absolute/path/to/dev-loop-venv/bin/python
"$PYTHON" "$PLUGIN_DIR/skills/sim-verify-task/scripts/build_report.py" .devloop/tasks --out .devloop/report.html
"$PYTHON" "$PLUGIN_DIR/skills/sim-verify-task/scripts/report_server.py" .devloop --port 8765
```

Open the localhost URL printed by the server. Its access token is a local secret. The server authenticates report/image access and writes button requests to the shared queue. It does not wake a finished chat. Continue the agent explicitly or use a user-requested live background session. One consumer operates a given queue; multiple report servers may use separate ports.

Each `.devloop/tasks/<task-id>/report.html` embeds its screenshots and can be opened directly. **Download HTML** exports only the selected task. **Open in Claude Artifact** opens its saved native artifact URL. If none exists, the button can request private publication through a listening interactive Claude Code session and open the actual returned URL. **Update Claude artifact** publishes the current page to the same artifact, preserving its link and discussion. The local HTML stays with the original task.

In interactive Claude Code, ask: “Use Dev Loop to enable the artifact button for this project and wait for my click.” The agent checks for the native Artifact tool, keeps the report server running, and waits for the click for a bounded period. Open the authenticated local URL it returns. Keep that session open until publication finishes. The [artifact bridge workflow](skills/sim-verify-task/references/claude-artifacts.md) explains setup, recovery and limitations. No credentials or background model service are added. `claude -p`, a detached file, and a Codex-only session cannot publish a native Claude artifact through this bridge. They can open an existing artifact; the page also offers a manual HTML handoff.

Share from the Claude viewer to invite the intended team. Organization comments require appropriate Team/Enterprise access; public-link-only viewers cannot comment. Editors can send comments to Claude with **Send to Claude** or `@claude`, subject to native session permissions. Updates retain the same artifact URL and comments. Native discussion is separate from the local report queue. See [Claude's artifact documentation](https://code.claude.com/docs/en/artifacts).

The bridge saves the actual `https://claude.ai/code/artifact/<uuid>` URL as `artifact_url` in `task.json` and rebuilds the page. An optional `source_url` links back to the original task; source links must be HTTPS without credentials, query strings or fragments. Local file association does not post to an external tracker.

`--wait 900` exits when work is queued (0) or the deadline expires (3), then the report URL stops working. The individual HTML files remain usable. `build_report.py --embed` also embeds screenshots in the aggregate index. Review a task's report before sharing it. Stop the server when finished.

## Reliability and limits

The queue rejects duplicates, stale attempts, failed checks and incomplete retest evidence. Interrupted stages are blocked until their effects are reconciled and explicitly resumed. External PR operations are not guaranteed exactly once. Evidence is trusted worker output checked for structure and integrity, not proof of reviewer independence or app behavior.

Image comparison preserves native-resolution color changes above its threshold; visual similarity cannot establish functional correctness. Council scores are heuristics, not probabilities or release approvals. An unavailable simulator or reviewer remains an incomplete check. The package has automated local regression coverage; a complete real-device, independent-review loop has not yet been verified end to end.

## Development and release

Run local checks using the environment above:

```bash
python -m unittest discover -s tests -v
node tests/report_ui.test.js
node --test tests/handoff/*.test.mjs
python tools/build_release.py --out dist
```

The release builder uses an allowlist and creates a reproducible ZIP, SHA-256 checksum and package audit. If publisher information is incomplete, explicitly use `--draft`; the audit identifies missing submission materials. It never uploads files or submits attestations. See [publication preparation](https://github.com/ChepelevIgor/dev-loop/blob/main/publication/README.md).

The source tree also supports Claude Code with `claude --plugin-dir .`. For a persistent installation from the public source, use `/plugin install dev-loop --marketplace ChepelevIgor/dev-loop`. Its notification hook is explicitly scoped through `.claude-plugin/hooks.json`. The public ZIP contains the portable manifest and skills, with no lifecycle hooks or app references. The Codex compatibility manifest remains for older local clients.
