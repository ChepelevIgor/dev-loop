#!/usr/bin/env python3
"""Read the bundled Dev Loop guide without starting a workflow."""
import argparse
from pathlib import Path
import re

GUIDE = Path(__file__).resolve().parents[1] / 'references' / 'guide.md'
ALIASES = {
    'check-app': 'sim-verify-task',
    'check-task': 'sim-verify-task',
    'review-task': 'close-threads',
    'dev-loop': 'start-task',
    'implement-task': 'start-task',
    'sim-verify': 'sim-verify-task',
    'pr-review-loop': 'close-threads',
    'review-pr': 'close-threads',
    'discuss-review': 'close-threads',
    'agent-council': 'debate',
    'council': 'debate',
    'handoff': 'filter-design',
    'handoff-check': 'filter-design',
    'handoff-push': 'filter-design',
    'design-to-tasks': 'filter-design',
    'check-design': 'filter-design',
    'update-design': 'filter-design',
    'bug-check': 'check-bug',
    'is-it-a-bug': 'check-bug',
    'compare-design': 'match-design',
    'design-match': 'match-design',
}


def sections(text):
    headings = list(re.finditer(r'^## ([a-z][a-z0-9-]*)\s*$', text, re.M))
    return {
        match.group(1): text[match.start():headings[i + 1].start() if i + 1 < len(headings) else len(text)].strip()
        for i, match in enumerate(headings)
    }


def main(argv=None):
    parser = argparse.ArgumentParser(
        description='Справка по Dev Loop: навыки, настройка, примеры и порядок работы.',
        epilog='Без темы выводится полное руководство. Пример: help.py filter-design',
    )
    parser.add_argument('topic', nargs='?', help='навык или раздел из --list')
    parser.add_argument('--list', action='store_true', help='показать доступные темы')
    args = parser.parse_args(argv)
    text = GUIDE.read_text(encoding='utf-8')
    topics = sections(text)
    if args.list:
        for topic, section in topics.items():
            title = next((line.strip('*') for line in section.splitlines()[1:] if line.startswith('**')), topic)
            print(f'{topic}: {title}')
        return 0
    if not args.topic:
        print(text.rstrip())
        return 0
    topic = ALIASES.get(args.topic, args.topic)
    if topic not in topics:
        parser.error('неизвестная тема; доступные темы: ' + ', '.join(topics))
    print(topics[topic])
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
