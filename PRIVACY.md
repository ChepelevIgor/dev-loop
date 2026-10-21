# Dev Loop privacy notice

Version: 0.5.0. Updated on 20 October 2026.

Dev Loop is a locally executed collection of skills and scripts maintained by Igor Chepelev. The package has no developer-operated backend, analytics endpoint, advertising or telemetry.

## Information used

When you request a workflow, the agent may read the selected repository, task descriptions, acceptance criteria, diffs, build/test output and PR comments. Simulator verification can capture app screenshots and device logs, including any personal information visible in the test app. The queue stores task identifiers, comments, attempt timestamps, commit IDs, results and artifact hashes to resume work and diagnose failures.

Use test data and an appropriate test account. Limit logs to the process and period needed for the task. Do not put passwords, API keys, login codes or other authentication secrets in task text, evidence or reports. GitHub and model tools use their existing local sign-in; Dev Loop has no credential form or credential store.

## Where information goes

Artifacts are written to `.devloop/` in the selected project. The local report server binds to loopback and requires an access token. Viewing a report does not upload it to a Dev Loop service. A portable embedded HTML report contains copies of its included screenshots.

Each task has an ordinary local HTML page by default. Downloading HTML does not upload data. Selecting **Open in Claude Artifact** without an existing link, or **Update Claude artifact**, requests private publication of that task's page and embedded screenshots through a listening Claude Code session. Only the native tool in that session performs the upload under your existing sign-in. The local bridge stores a frozen HTML snapshot, request state, source hash and returned artifact URL. It stores no model credentials. Local server tokens and other tasks are excluded from the snapshot and downloaded pages. A manual handoff sends the same content only when you attach it in Claude.

Artifacts, sharing permissions and team comments are hosted by Claude under its terms and your account settings. New artifacts remain private until shared through Claude. Updating an existing artifact preserves its sharing settings. The plugin does not automatically invite teammates, publish publicly or copy native comments into an issue tracker.

The host assistant and any separately invoked reviewer process receive the task material used in that workflow. Their processing follows the host or model provider's terms and privacy settings. GitHub CLI reads PR data from GitHub, and sends code, PR text or comments to GitHub only as part of an authorized publishing action. The app being tested, build tools and project-supplied workers may contact services configured by that project. Installing dependencies contacts the configured package index. These services have their own data practices.

The publisher does not automatically receive your code, task records, screenshots or logs. If you choose to send a support report, its content goes to the support channel you select; public GitHub issues are publicly visible. Remove private data before sharing.

## Retention and controls

Local task records and evidence remain until you remove or archive them. They do not expire automatically. Stop the runner and report server before deleting `.devloop/`; keep anything you need first. Reports copied elsewhere and data posted to GitHub or sent to a host/model service must be managed through those destinations. Uninstalling the plugin does not delete project evidence or copies you shared.

You choose the project, task, device and scope. You can stop a stage, decline an external action, restrict what material a reviewer receives and remove local evidence. The loopback access token limits report access but does not isolate files from other processes running as the same operating-system user.

Publisher profile: https://github.com/ChepelevIgor

Public policy: https://github.com/ChepelevIgor/dev-loop/blob/main/PRIVACY.md

For questions about this notice, use the [support page](https://github.com/ChepelevIgor/dev-loop/blob/main/SUPPORT.md). Do not include private app data or credentials in a public support request.
