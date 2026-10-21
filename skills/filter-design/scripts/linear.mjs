// Linear over GraphQL with LINEAR_API_KEY (env, or the design repo's .env.local / .env). Fails closed: if a check
// can't run, nothing is created (a duplicate task or a task without its pictures is worse than a retry).
import fs from 'node:fs';
import path from 'node:path';

export function linearKey(root) {
  if (process.env.LINEAR_API_KEY) return process.env.LINEAR_API_KEY;
  if (process.env.LINEAR_API_KEY === '') return null;
  for (const f of ['.env.local', '.env']) {
    const file = path.join(root, f);
    const m = /^\s*(?:export\s+)?LINEAR_API_KEY=(.*)$/m.exec(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
    if (m) return m[1].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return null;
}

export function client(key) {
  const url = process.env.LINEAR_API_URL ?? 'https://api.linear.app/graphql';
  async function gql(query, variables = {}) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: key }, body: JSON.stringify({ query, variables }) });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || j.errors) throw new Error(`Linear: ${j?.errors?.[0]?.message ?? `response ${r.status}`}`);
    return j.data;
  }
  return {
    gql,
    /** Upload a picture to Linear's storage → its asset URL (to embed in a description or a comment). */
    async upload(file, contentType = 'image/png') {
      const buf = fs.readFileSync(file);
      const d = await gql('mutation($ct:String!,$fn:String!,$sz:Int!){ fileUpload(contentType:$ct, filename:$fn, size:$sz){ success uploadFile { uploadUrl assetUrl headers { key value } } } }', { ct: contentType, fn: path.basename(file), sz: buf.length });
      const u = d.fileUpload?.uploadFile;
      if (!d.fileUpload?.success || !u) throw new Error(`Linear gave no upload URL for ${path.basename(file)}`);
      const headers = { 'content-type': contentType, 'cache-control': 'public, max-age=31536000' };
      for (const h of u.headers ?? []) headers[h.key] = h.value;
      const put = await fetch(u.uploadUrl, { method: 'PUT', headers, body: buf });
      if (!put.ok) throw new Error(`the picture ${path.basename(file)} did not upload to Linear (${put.status})`);
      return u.assetUrl;
    },
    async teamId(keyName) {
      const t = (await gql('query($k:String!){ teams(filter:{ key:{ eq:$k } }){ nodes { id } } }', { k: keyName })).teams.nodes[0];
      if (!t) throw new Error(`Linear has no team ${keyName}`);
      return t.id;
    },
    async labelIds(teamId, names) {
      if (!names?.length) return [];
      const d = await gql('query($t:String!){ issueLabels(filter:{ team:{ id:{ eq:$t } } }, first:250){ nodes { id name } } }', { t: teamId });
      return (d.issueLabels?.nodes ?? []).filter((l) => names.some((n) => n.toLowerCase() === l.name.toLowerCase())).map((l) => l.id);
    },
    /** A task carrying this marker in its description, if one exists (an earlier press that died before saving). */
    async findByMarker(marker) {
      return (await gql('query($q:String!){ issues(filter:{ description:{ contains:$q } }, first:1){ nodes { id identifier url } } }', { q: marker })).issues?.nodes?.[0] ?? null;
    },
    /** Full-text search: tasks that may already cover this work (the designer picks one on the page, or "new"). */
    async search(term, { teamId = null, first = 5 } = {}) {
      const d = await gql('query($q:String!,$t:String,$n:Int){ searchIssues(term:$q, teamId:$t, first:$n){ nodes { id identifier title url state { name type } } } }', { q: term, t: teamId, n: first });
      const nodes = d.searchIssues?.nodes;
      if (!Array.isArray(nodes)) throw new Error('Linear did not return search results');
      return nodes.map((x) => ({ identifier: x.identifier, title: x.title, url: x.url, state: x.state?.name ?? null, stateType: x.state?.type ?? null }));
    },
    async create({ teamId, title, description, labelIds = [] }) {
      const d = await gql('mutation($i:IssueCreateInput!){ issueCreate(input:$i){ success issue { id identifier url } } }', { i: { teamId, title, description, ...(labelIds.length ? { labelIds } : {}) } });
      if (!d.issueCreate?.success) throw new Error('Linear did not create the issue');
      return d.issueCreate.issue;
    },
    /** An issue by its key (TASK-1234) — the task the designer named. */
    async issueByKey(key) {
      const d = await gql('query($id:String!){ issue(id:$id){ id identifier url title } }', { id: key });
      if (!d.issue) throw new Error(`Linear has no issue ${key}`);
      return d.issue;
    },
    /** Task context for verification/review, including every linked PR attachment. Read-only. */
    async taskDetails(key) {
      let after = null;
      let task;
      const attachments = [];
      const seen = new Set();
      for (;;) {
        const d = await gql('query($id:String!,$after:String){ issue(id:$id){ id identifier title description url branchName attachments(first:100,after:$after){ nodes { title url } pageInfo { hasNextPage endCursor } } } }', { id: key, after });
        const issue = d?.issue;
        if (!issue || issue.identifier !== key) throw new Error('Linear did not return the requested task');
        const page = issue.attachments;
        if (!Array.isArray(page?.nodes) || typeof page.pageInfo?.hasNextPage !== 'boolean') throw new Error('Linear returned incomplete task links');
        task ??= { id: issue.id, identifier: issue.identifier, title: issue.title, description: issue.description,
          url: issue.url, suggestedBranch: issue.branchName };
        attachments.push(...page.nodes);
        if (!page.pageInfo.hasNextPage) return { ...task, attachments };
        after = page.pageInfo.endCursor;
        if (!after || seen.has(after)) throw new Error('Linear returned an invalid task link cursor');
        seen.add(after);
      }
    },
    /** Search all comment pages before replaying an uncertain publication to an existing issue. */
    async findCommentByMarker(issueId, marker) {
      let after = null;
      const seen = new Set();
      for (;;) {
        const d = await gql('query($id:String!,$after:String){ issue(id:$id){ comments(first:100,after:$after){ nodes { id url body } pageInfo { hasNextPage endCursor } } } }', { id: issueId, after });
        const c = d.issue?.comments;
        if (!Array.isArray(c?.nodes) || typeof c.pageInfo?.hasNextPage !== 'boolean') throw new Error('Linear did not return the issue comments; cannot safely retry');
        const found = c.nodes.find((x) => x.body?.includes(`<!-- ${marker} -->`));
        if (found) return found;
        if (!c.pageInfo.hasNextPage) return null;
        after = c.pageInfo.endCursor;
        if (!after || seen.has(after)) throw new Error('Linear returned an invalid comment cursor; cannot safely retry');
        seen.add(after);
      }
    },
    /** A link on the issue (idempotent by URL: the same URL again updates it). */
    async attach(issueId, url, title, subtitle = '') {
      const d = await gql('mutation($i:AttachmentCreateInput!){ attachmentCreate(input:$i){ success attachment { id } } }', { i: { issueId, url, title, ...(subtitle ? { subtitle } : {}) } });
      if (!d.attachmentCreate?.success) throw new Error(`Linear did not attach "${title}"`);
      return d.attachmentCreate.attachment.id;
    },
    async comment(issueId, body) {
      const d = await gql('mutation($i:CommentCreateInput!){ commentCreate(input:$i){ success comment { id url } } }', { i: { issueId, body } });
      if (!d.commentCreate?.success) throw new Error('Linear did not accept the comment');
      return d.commentCreate.comment;
    },
  };
}
