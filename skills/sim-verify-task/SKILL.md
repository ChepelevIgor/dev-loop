---
name: sim-verify-task
description: Проверяет задачу до и после изменений по номеру Linear, описанию или PR. Примеры sim-verify-task T-10, sim-verify-task PR 2 и sim-verify-task Проверь сохранение имени. Для нескольких задач делает отдельные отчёты.
argument-hint: "T-10 [T-11 ...] или описание задачи или PR 2"
---

# Проверить задачу до и после

`sim-verify-task T-10` проверяет задачу Linear; `sim-verify-task Проверь сохранение имени после перезапуска` — задачу из описания; `sim-verify-task PR 2` — результат изменений в PR №2. `sim-verify-task T-10 T-11` проверяет обе задачи отдельно. Для каждой показывает состояние до изменений, результат после и выполнение условий задачи.

Справка и примеры: [help](../help/references/guide.md#sim-verify-task).

Resolve `SKILL_DIR` from this file's absolute path. Scripts are in `scripts/`. Run locally with the tools required by the task's criteria. Mobile UI checks need a reachable simulator; non-UI checks use the relevant project tests or API operations. Do not invent a cloud device bridge. Missing required device access means unavailable verification, not a passing result.

## Select the requested tasks

Read [task-scope.md](references/task-scope.md) to resolve the supplied Linear IDs, description or PR. Derive observable acceptance criteria from that source and locate the actual implementation. PR numbers refer to the current repository; PR links identify their own repository. A description or PR does not require a Linear issue. Use the exact Linear identifier when supplied, otherwise preserve or create a local task ID as described there.

For multiple IDs, preserve separate criteria, versions, runs and report pages for each task. Share a build only when the verified commits really match. A failed lookup for one task does not prevent checking other resolved tasks. Do not expand the request to the whole app, other Linear issues or code review.

The default is both before and after. Choose a real pre-change baseline and the task's implemented version; do not compare two screenshots of the same changed build. If the user asks only for the baseline, capture it. If implementation is absent, show the baseline as `not-implemented`; if a historical build cannot run, mark that part unavailable rather than inventing evidence. For a non-UI criterion, use an appropriate observable test and state that screenshots do not apply; the tracked mobile RETEST contract still requires its specified screenshot evidence.

## Prepare

The report builder uses Python 3.10+. For mobile UI comparisons, use Pillow/NumPy and Bash, and activate that Python environment because shell helpers invoke `python3`. iOS requires macOS, Xcode, a booted Simulator and `idb` for precise taps. Android requires the SDK, `adb` and a booted emulator. `bash "$SKILL_DIR/scripts/sim.sh" detect` reports the selected device. With multiple devices, explicitly set `SIM_PLATFORM` (`ios` or `android`) and `SIM_DEVICE` for every command. iOS coordinates are device points; Android coordinates are pixels.

Inspect the working tree. Use isolated checkouts for baseline and target builds if switching would affect user work. Build and install both versions, then reproduce the same data and scenario. `sim.sh build` requires an executable `scripts/sim-build.sh` in the target app project; it has no automatic Xcode/Gradle fallback.

Use sample app data. Keep screenshots and logs limited to the requested scenario. Do not capture login secrets or include credentials in reports. Project logs may contain private data; inspect them before sharing with a reviewer or publishing.

## Verify

1. Read `task.json` and `brief.md`. Each acceptance criterion must describe observable behavior.
2. Without an implementation branch or PR, capture baseline only and mark `not-implemented`. Do not invent after images or offer PR/retest actions before implementation.
3. For each UI criterion, navigate the intended app/device, use `sim.sh settle`, then `sim.sh shot <path>`. Repeat on the target version with the same steps and data. For non-UI criteria, run the same relevant test or API scenario on both versions and save the observed results.
4. For criteria with screenshots, compare paired image directories:

   ```bash
   python3 "$SKILL_DIR/scripts/imgdiff.py" before/ after/ diff/ --json diff.json
   ```

   Empty sets, missing pairs, invalid files and dimension mismatches are errors. The color mask and bounding boxes use native resolution with a per-channel threshold of 24. SSIM/pHash use smaller grayscale copies as structural hints; they do not establish functional correctness. Inspect colors and small changes visually.
5. Open the images with an available image viewer. Record `pass`, `fail` or `partial` per criterion with evidence. Save device ID, image size, build commits, data state, steps and errors. Android logs are incremental per device/filter, with timestamp-boundary duplicate handling; the first call reads the available buffer. Logs already lost by the device cannot be recovered. Do not clear the shared log buffer.
6. Save `tasks/<id>/runs/<n>/report.json` in a new, higher-numbered run, preserving previous runs. For an active Dev Loop RETEST, include its `request_id` and `attempt_id` in the report as well as `head_sha`; a standalone check after DONE must omit the old request and attempt IDs. Image paths are task-relative PNG paths under `runs/<n>/{before,after,diff}/`; external paths and URLs are not accepted. Example shape (replace the illustrative commit with the real HEAD):

   ```json
   {"task_id":"APP-123","run":2,"baseline":"base@abc1234","baseline_kind":"base-branch",
    "head_sha":"CURRENT_COMMIT_SHA","status":"partial","device":"ios:DEVICE-ID","steps":["Open profile"],
    "criteria":[{"id":"c1","text":"The profile button is visible","verdict":"pass","note":"Visible in the screenshot",
    "before":"runs/2/before/c1.png","after":"runs/2/after/c1.png","diff":"runs/2/diff/c1.png",
    "ssim":0.71,"hamming":19}]}
   ```

A passing report needs a nonempty, completely verified criterion list. Any failed criterion makes the report fail; otherwise incomplete evidence is partial. A previous after image can be a retest baseline only when explicitly marked `baseline_kind: previous-run`; this does not establish regression safety against the base branch. For a tracked Dev Loop request, criterion texts must match task acceptance exactly; read `../start-task/references/runtime.md` before completing the stage. Submitting a valid partial result preserves its evidence but does not complete RETEST: block the interactive attempt with the reason and rebuild the page so the available observations remain visible.

## Report and queue

HTML is the default deliverable. Build the task page as soon as `task.json` exists, even before a simulator run, and rebuild it when evidence changes. Do not automatically create a Claude artifact, cloud page, or hosted report. The builder writes a self-contained page with embedded screenshots at `tasks/<task-id>/report.html` and a `report-page.json` association beside it. The aggregate report is an index; deliver the individual task page to avoid mixing unrelated tasks.

```bash
python3 "$SKILL_DIR/scripts/build_report.py" .devloop/tasks --out .devloop/report.html
python3 "$SKILL_DIR/scripts/report_server.py" .devloop --port 8765 --wait 900
```

Use a supported background terminal session and give the user the printed localhost URL. Keep its token private. Reads require authentication and expose only the report, pending task IDs and permitted PNGs. The button enqueues transactionally through the sibling Dev Loop runtime. Duplicate active tasks are rejected across servers. Multiple report servers can use separate ports; only one queue consumer may run.

Attach or link the per-task HTML file in the original task conversation using the host's supported file presentation tools. If only text is available, provide an absolute local file link/path. Open a preview when supported. `report-page.json` records the local association; it does not prove attachment to an external issue or chat. Never describe an attachment as successful without a tool result or a visible file link. For an external tracker, store its real HTTPS URL as `source_url` in `task.json` (no credentials, query string, or fragment). Update that external task only within the user's publishing authorization, using a real accessible URL or supported file upload; a local path is not accessible to remote collaborators.

Both the aggregate and individual pages offer **Download HTML** and **Open in Claude Artifact**. Downloads include only the selected task and its images, without the server token or other tasks. The artifact button opens a saved native artifact, or requests private publication through a live interactive Claude Code session. Read [claude-artifacts.md](references/claude-artifacts.md) when enabling the button, publishing/updating, or handling team comments. A click is a publication request, not proof of success. The bridge records the actual native tool result and rebuilds the task page; repeated updates keep the same artifact URL and comments.

`--wait` exits with 0 when work is queued and 3 on timeout. After exit, its URL stops working. For a persistent report session, omit `--wait` and stop it after use. The button cannot wake a finished agent turn; the user must continue the task or have explicitly requested a live waiting session. Use the runtime CLI for transitions, not manual queue-file moves.

Individual pages always embed screenshots and work after the server stops. `build_report.py ... --embed` also embeds images in the aggregate index. Offline pages support downloads and opening an existing artifact. First-time publication needs a live report server and a capable Claude session; otherwise show the manual handoff and state that nothing was published. The hosted artifact uses native Claude comments; it cannot access the local report queue. Review the selected page before sharing.
