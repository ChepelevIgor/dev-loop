# Runtime and worker contract

Use the installed plugin's absolute path and the target project's working directory. The examples use a Python environment with the plugin's requirements installed; activate it so `python3` in `sim.sh` uses the same dependencies.

```bash
PLUGIN_DIR=/absolute/path/to/dev-loop
PYTHON=/absolute/path/to/venv/bin/python
CLI="$PLUGIN_DIR/skills/start-task/scripts/devloop.py"
"$PYTHON" "$CLI" --root .devloop status
"$PYTHON" "$CLI" --root .devloop enqueue APP-123 --action retest
"$PYTHON" "$CLI" --root .devloop start
```

Create `tasks/APP-123/task.json` before enqueueing. Example data:

```json
{"id":"APP-123","title":"Verify the profile button","branch":"feature/profile-button","acceptance":["The profile button is visible"]}
```

`execute` starts at BRIEF, `pr` at PR, `retest` at RETEST. `start` returns `request_id`, `attempt_id`, `stage`, `head_sha` and the request's `comment`. Save evidence under this task and return an object with those exact IDs and `completed: true`. `head_sha` is the current commit; only EXECUTE and FIX may change it. Artifact paths are relative to `.devloop`, must belong to this task and must not traverse symlinks.

```json
{
  "request_id":"the-active-request-id",
  "attempt_id":"the-active-attempt-id",
  "stage":"RETEST",
  "head_sha":"the-current-git-commit",
  "completed":true,
  "artifacts":{"report":"tasks/APP-123/runs/1/report.json"}
}
```

Save this result, then run:

```bash
"$PYTHON" "$CLI" --root .devloop complete REQUEST_ID --result .devloop/result.json
```

Replace the example values with observed values. Successful completion validates evidence and updates the queue transactionally. A nonzero exit is not a successful transition; inspect `status`. Filesystem export can fail after a database commit, so reconcile the persisted status before repeating work.

| Stage | Required artifact keys and contents | Next stage |
|---|---|---|
| BRIEF | `brief`: the business review ([schema](brief.schema.json)) — metric (null only with a `product` gap), summary, DoD, Given / When / Then cases whose `text` values are exactly task.json `acceptance`, gaps with `blocking`, and `base_sha` equal to task.json `base_sha`. | PLAN; a blocking gap → blocked at BRIEF with the questions as the error |
| PLAN | `plan`: the technical solution as Markdown (not JSON), at least a few paragraphs. | QA |
| QA | `qa`: test cases ([schema](qa.schema.json)) with `author` and `independent`; every acceptance criterion has a case. | EXECUTE |
| EXECUTE / FIX | `checks`: JSON with `passed: true`, current `head_sha`, nonempty `commands` containing actual `argv` arrays and integer `exit_code: 0`. Keep command logs alongside it. EXECUTE must be committed on task.json `branch` (never `main`/`master`). | REVIEW |
| PR | `pr`: JSON with positive integer `number`, actual HTTPS `url`, current `head_sha`. | REVIEW |
| REVIEW | `review`: `{completed: true, findings: [...]}`; `threads`: array with string `body` and boolean `resolved`, preserving all local findings and, when the task has a PR, its GitHub threads. Without a PR the threads are the local findings. | COUNCIL if any unresolved; otherwise RETEST |
| COUNCIL | `verdict`: nonempty `decision`, nonempty `must`, each with evidence. Preserve evidence supporting each item; the aggregator output alone is insufficient. | FIX |
| RETEST | `report`: current `head_sha`, status and criteria covering exactly the task's acceptance texts. Each passing criterion requires a valid PNG at `runs/<number>/after/<name>.png`, relative to the task. | DONE if all pass; COUNCIL on failure; blocked on incomplete evidence |

The runtime validates structure, commit matching and file integrity. It cannot establish that a worker actually ran a command, that an image came from the app, or that a review was independent. Agents must obtain real results and inspect them; never fabricate evidence to advance. Completed event records include evidence hashes for later comparison, not immutable storage or cryptographic attestation.

For a tracked task, the HTML report shows the latest request's evidence using the paths and hashes in its event journal. Nested evidence paths are supported. REVIEW combines local findings and collected GitHub threads without duplicating the local findings; distinct GitHub thread IDs remain separate. A new request starts with pending criteria, without the previous request's plan, QA or successful retest. Retrying a stage or starting a code fix invalidates the corresponding older result. Missing or changed evidence is reported on the page. The builder reads SQLite without changing it, or the exported state and journal when the database is absent.

A valid partial RETEST submitted through `complete` records a `progress` event with the report path and hash, then exits nonzero without advancing the stage or acknowledging the request. Any `task_id`, `request_id` or `attempt_id` present inside the report must match the active attempt; older worker reports without these optional fields remain supported. The page also checks these identifiers against the attempt that recorded the report, so inconsistent events saved by older versions are shown as unavailable evidence.

The runner blocks an incomplete attempt automatically; in an interactive session, use `block` with the observed reason. Rebuilding the page preserves the partial observations, notes and available screenshots. For a tracked partial RETEST, missing, unreadable or invalid images are omitted from both the index and portable page with a warning; the saved JSON evidence is not changed. Other verification reports retain strict image handling. If you block directly without submitting a result, save a numeric `runs/<n>/report.json` with the active `request_id`, `attempt_id`, `head_sha`, `status: partial`, and criteria matching the task; it can be shown as a preview only for that running or blocked attempt. A recorded report that fails its hash check is never replaced by an unchecked preview.

After DONE, a standalone simulator check can replace the displayed verification: save it in a new, higher-numbered run after the request finished, without the old `request_id` or `attempt_id`. The builder checks the run number and file modification time, so preserve timestamps when copying old evidence. This standalone report does not inherit the completed loop's stage artifacts or DONE label. Starting a new managed request again shows only that request's evidence. Tasks without a tracked request use the standalone stage files and latest numeric report.

## The page's Dev Loop button

`devloop.py send <task> --comment "…"` (and the report server's `/send`) is the button: a blocked request takes the
comment as its answer and becomes ready at the same stage (`resume --comment` does the same by request ID); with no
active request, or after DONE, a new request starts (`execute` by default) with the comment; a running or queued
request answers "in progress".

## Recovery

Only one CLI consumer runs at once. Interactive attempts also retain `running` state after `start` exits. Stop or locate the old executor before recovery; an interrupted external action may already have succeeded.

```bash
"$PYTHON" "$CLI" --root .devloop block REQUEST_ID --attempt-id ATTEMPT_ID --reason "Explain the observed failure"
"$PYTHON" "$CLI" --root .devloop recover
"$PYTHON" "$CLI" --root .devloop resume REQUEST_ID
```

`recover` imports old queue files once, regenerates JSON views and blocks interrupted stages. `resume` permits a new attempt after reconciliation; it does not erase the correction count. Check GitHub for an existing PR before retrying PR creation. Older `taken` files import as blocked. Do not manually move requests to `done`.

## Optional process workers

Use only an explicitly selected trusted local configuration. Each configured stage provides an `argv` array and optional timeout in seconds, up to 3600. No shell is used and task comments are never interpolated into command arguments.

```json
{"stages":{"RETEST":{"argv":["/absolute/path/to/python","/absolute/path/to/project/retest-worker.py"],"timeout":600}}}
```

This is a contract example, not a bundled worker. The worker receives one JSON object on stdin containing the attempt plus `root`, `project` and `task`. It writes exactly one result JSON object to stdout, diagnostics to stderr, and exits 0 only on success. Use this interface to adapt the project's real build, reviewer and simulator tools. Configure all stages the selected action may reach.

```bash
"$PYTHON" "$CLI" --root .devloop run --config .devloop/workers.json --max-steps 16
```

`--watch-seconds 900` keeps the same bounded process waiting for queued work when requested. The runner saves input/stdout/stderr per attempt, has output and timeout limits and blocks invalid results. Exit codes: 0 no remaining runnable work (inspect status), 2 blocked/error, 3 stage budget reached, 130 interrupted. The parent keeps a process lock and passes it to the worker; a crashed parent cannot start a second consumer while that worker retains the descriptor.

`runtime.sqlite3` is the source of truth. `state.json`, `runtime/events.json` and `queue/{taken,done}` are exported views. Back up the state directory only after stopping its writers. There is no remote queue, scheduler, merge automation or automatic retry of uncertain external actions.
