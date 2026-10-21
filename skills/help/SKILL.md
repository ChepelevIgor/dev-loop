---
name: help
description: Объясняет простым языком, как пользоваться плагином Dev Loop и какой навык выбрать. Используй для вопросов о командах плагина, настройке, этапах работы, кнопках отчёта и продолжении задачи.
argument-hint: "[название навыка или вопрос]"
---

# Помощь по Dev Loop

Помоги пользователю понять, что умеет этот плагин и как получить нужный результат.

Read [the user guide](references/guide.md). Reply in the user's language. For a general help request, explain the two main workflows, list the eight skills (start-task, sim-verify-task, check-bug, close-threads, debate, filter-design, match-design, help) with one plain sentence each, and give a starting example. For a specific question, read the relevant section and explain the inputs, result, requirements and next step. For a request for detailed help, cover the full guide.

Use the current skill names. The guide's migration table maps old names to the new ones; old names are search terms for this help, not additional installed skills. Distinguish chat skill commands from terminal helpers. Explain technical terms when they are needed.

Explain the input forms explicitly: `start-task T-10` or a task description; `sim-verify-task T-10`, a description or `sim-verify-task PR 2`; `close-threads PR 2` to review the PR, settle every remark, reply and resolve its threads; `check-bug TASK-12` to reproduce a reported bug and say whether it is one; `match-design` with a screenshot (whole screen or a part) to compare the app with the current workbench design. PR numbers use the current repository; links can select another repository. Descriptions and PR-only requests do not require Linear. `sim-verify-task T-10 T-11` keeps separate task checks and reports.

Help itself only reads bundled documentation. Do not start a development task, install dependencies, launch reviewers or simulators, create an artifact, or publish anything merely because the user asks how a workflow works. If the user also asks to perform the work, route to the relevant sibling skill within that scope.

For terminal access, `python3 <this skill folder>/scripts/help.py` prints the full guide, `help.py --list` lists topics, and `help.py <topic>` prints one section. It works outside a project without Git, credentials or simulator access.
