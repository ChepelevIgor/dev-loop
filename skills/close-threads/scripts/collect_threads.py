#!/usr/bin/env python3
"""Collect PR discussion and local findings; --github-only reads discussion without a local review."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import os

QUERY = '''query($owner:String!,$name:String!,$pr:Int!,$endCursor:String){
 repository(owner:$owner,name:$name){pullRequest(number:$pr){
 reviewThreads(first:100,after:$endCursor){pageInfo{hasNextPage endCursor}
 nodes{id isResolved isOutdated path line comments(first:100){pageInfo{hasNextPage endCursor}
 nodes{author{login} body createdAt}}}}}}}'''
COMMENT_QUERY = '''query($id:ID!,$endCursor:String){node(id:$id){... on PullRequestReviewThread{
 comments(first:100,after:$endCursor){pageInfo{hasNextPage endCursor} nodes{author{login} body createdAt}}}}}'''
SEVERITIES = {"blocker", "major", "minor", "nit"}
CATEGORIES = {"correctness", "design", "perf", "security", "ux", "test"}


def gh(*args):
    result = subprocess.run(["gh", "api", *args], text=True, capture_output=True, check=True)
    data = json.loads(result.stdout)
    pages = data if isinstance(data, list) else [data]
    for page in pages:
        if isinstance(page, dict) and page.get("errors"):
            raise ValueError(f"GitHub GraphQL errors: {page['errors']}")
    return data


def tags(file, body):
    text = f"{file or ''} {body}".lower()
    patterns = {"ui": r"\b(ui|view|screen|layout|swiftui|compose)\b|viewmodel",
                "test": r"test|spec", "network": r"\b(api|http|request|endpoint|url)\b|network",
                "state": r"store|state|reducer|cache|viewmodel", "perf": r"\b(perf|performance|slow|memory|latency|complexity)\b",
                "security": r"\b(auth|token|secret|crypto|injection|xss|leak|pii)\b",
                "algo": r"\b(algorithm|sort|graph|numeric|precision|float|matrix|invariant)\b",
                "design": r"\b(design|spacing|color|font|padding|accessibility|a11y|contrast)\b"}
    return sorted(tag for tag, pattern in patterns.items() if re.search(pattern, text))


def normalize_findings(data):
    if isinstance(data, dict) and "findings" in data:
        if data.get("completed") is not True:
            raise ValueError("review did not report completed=true")
        data = data["findings"]
    elif isinstance(data, dict) and "body" in data:
        data = [data]
    if not isinstance(data, list):
        raise ValueError("expected findings array or {completed:true, findings:[]}; raw Codex events are not findings")
    for finding in data:
        if not isinstance(finding, dict) or not isinstance(finding.get("body"), str) or not finding["body"].strip():
            raise ValueError("finding must contain nonempty body")
        if finding.get("severity") not in SEVERITIES or finding.get("category") not in CATEGORIES:
            raise ValueError("invalid finding severity/category")
        if finding.get("file") is not None and not isinstance(finding["file"], str):
            raise ValueError("invalid finding file")
        if finding.get("line") is not None and (type(finding["line"]) is not int or finding["line"] < 1):
            raise ValueError("finding line must be positive or null")
    return data


def collect(repo, pr, directory, *, github_only=False):
    directory = Path(directory)
    # A failed refresh must not leave a previous success masquerading as the new run.
    output = directory / ("github-threads.json" if github_only else "threads.json")
    output.unlink(missing_ok=True)
    local_files = [] if github_only else sorted(
        p for p in directory.glob("*") if p.suffix in {".json", ".jsonl"}
        and p.name.startswith(("codex", "claude", "agent")))
    if not github_only and not local_files:
        raise ValueError("no structured local review; normalize the reviewer output first")
    out = []

    def add(source, finding, stable_id=None, **extra):
        record = {"source": source, "file": finding.get("file"), "line": finding.get("line"),
                  "severity": finding["severity"], "category": finding["category"], "body": finding["body"].strip(),
                  "resolved": False, "decision": None, "tags": tags(finding.get("file"), finding["body"]), **extra}
        fingerprint = json.dumps([source, record["file"], record["line"], record["body"]], ensure_ascii=False).encode()
        record["id"] = stable_id or f"{source}-{hashlib.sha256(fingerprint).hexdigest()[:16]}"
        if not any(r["id"] == record["id"] for r in out):
            out.append(record)

    for path in local_files:
        text = path.read_text(encoding="utf-8")
        try:
            chunks = [json.loads(text)]
        except ValueError:
            if path.suffix != ".jsonl":
                raise
            chunks = [json.loads(line) for line in text.splitlines() if line.strip()]
        if not chunks:
            raise ValueError(f"empty review output: {path}")
        source = path.stem.split("-", 1)[0].split(".", 1)[0]
        source = "codex" if source.startswith("codex") else "claude" if source.startswith("claude") else "agent"
        for chunk in chunks:
            for finding in normalize_findings(chunk):
                add(source, finding)

    owner, name = repo.split("/")
    pages = gh("graphql", "--paginate", "--slurp", "-f", f"owner={owner}", "-f", f"name={name}", "-F", f"pr={pr}", "-f", f"query={QUERY}")
    for page in pages:
        connection = page["data"]["repository"]["pullRequest"]["reviewThreads"]
        for thread in connection["nodes"]:
            comments = list(thread["comments"]["nodes"])
            if thread["comments"]["pageInfo"]["hasNextPage"]:
                more = gh("graphql", "--paginate", "--slurp", "-f", f"id={thread['id']}", "-f", f"endCursor={thread['comments']['pageInfo']['endCursor']}", "-f", f"query={COMMENT_QUERY}")
                for extra_page in more:
                    comments.extend(extra_page["data"]["node"]["comments"]["nodes"])
            body = "\n\n".join(f"@{(c.get('author') or {}).get('login', '?')}: {c.get('body', '')}" for c in comments)
            add("github", {"file": thread.get("path"), "line": thread.get("line"), "severity": "major", "category": "correctness", "body": body},
                stable_id=thread["id"], resolved=bool(thread["isResolved"]), outdated=bool(thread["isOutdated"]), gh_thread_id=thread["id"])
    for page in gh(f"repos/{repo}/pulls/{pr}/reviews", "--paginate", "--slurp"):
        for review in page:
            if not review.get("body", "").strip():
                continue
            state = review.get("state")
            add("github", {"severity": "major" if state == "CHANGES_REQUESTED" else "minor", "category": "correctness", "body": review["body"]},
                stable_id=f"github-review-{review['id']}", resolved=state in {"APPROVED", "DISMISSED"}, review_state=state)
    if github_only:
        for page in gh(f"repos/{repo}/issues/{pr}/comments", "--paginate", "--slurp"):
            for comment in page:
                if not comment.get("body", "").strip():
                    continue
                add("github", {"severity": "minor", "category": "correctness", "body": comment["body"]},
                    stable_id=f"github-comment-{comment['id']}", gh_comment_id=comment["id"],
                    author=(comment.get("user") or {}).get("login"), url=comment.get("html_url"))
    fd, temp = tempfile.mkstemp(prefix=".threads-", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(out, stream, ensure_ascii=False, indent=2)
        os.replace(temp, output)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)
    print(f"{len(out)} threads ({sum(not r['resolved'] for r in out)} open) → {output}")
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repo")
    parser.add_argument("pr", type=int)
    parser.add_argument("directory")
    parser.add_argument("--github-only", action="store_true",
                        help="collect existing PR discussion into github-threads.json without a local code review")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", args.repo) or args.pr < 1:
        parser.error("expected OWNER/REPO and positive PR number")
    Path(args.directory).mkdir(parents=True, exist_ok=True)
    try:
        collect(args.repo, args.pr, args.directory, github_only=args.github_only)
    except (ValueError, KeyError, TypeError, OSError, subprocess.CalledProcessError) as exc:
        print(f"review collection failed: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
