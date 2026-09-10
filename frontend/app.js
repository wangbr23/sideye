// Read-only diff frontend (LLD §8). No framework, no bundler: plain DOM built
// with textContent only — diff content, paths, and comments are untrusted data.
// Comments/analysis UI arrive in later tasks; this shell owns the diff pane,
// the round selector, and the SSE subscribe → reconnect refetch loop.

const SSE_EVENTS = ["analysis.update", "answer", "plan.ready", "status.ready", "round.prompt"]
const BANNER_AFTER_FAILURES = 3
const PANEL_TABS = ["Analysis", "Findings", "Comments", "Status"]

let reviewState = null // latest /api/state projection
let selectedRound = null // null → latest round
let activeTab = "Analysis"
let reconnectFailures = 0
let openForm = null // draft comment: { scope, anchor, text, isLesson }
let qaLog = [] // transient Q&A exchanges this tab has seen

const hunkObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      renderHunkInto(entry.target)
      hunkObserver.unobserve(entry.target)
    }
  },
  { rootMargin: "300px" },
)

async function refresh() {
  const res = await fetch("/api/state")
  if (!res.ok) throw new Error(`state fetch failed: ${res.status}`)
  reviewState = await res.json()
  const rounds = reviewState.rounds
  if (rounds.length > 0) {
    const stillExists = rounds.some((r) => r.n === selectedRound)
    if (selectedRound === null || !stillExists) selectedRound = rounds[rounds.length - 1].n
  }
  render()
}

function render() {
  renderTargetLabel()
  renderRoundSelector()
  renderDiff()
  renderPanel()
}

function renderTargetLabel() {
  const target = reviewState.target
  const text =
    target.kind === "worktree"
      ? "Worktree changes vs HEAD"
      : `Commit ${target.sha.slice(0, 10)} vs first parent`
  document.getElementById("target-label").textContent = text
}

function renderRoundSelector() {
  const select = document.getElementById("round-select")
  const rounds = reviewState.rounds
  select.disabled = rounds.length === 0
  select.replaceChildren(
    ...rounds.map((r) => {
      const option = document.createElement("option")
      option.value = String(r.n)
      option.textContent = `Round ${r.n}`
      return option
    }),
  )
  if (selectedRound !== null) select.value = String(selectedRound)
}

function renderDiff() {
  const pane = document.getElementById("diff-pane")
  const round = reviewState.rounds.find((r) => r.n === selectedRound)
  if (!round) {
    pane.replaceChildren(el("p", "empty", "No rounds captured yet."))
    return
  }
  if (round.files.length === 0) {
    pane.replaceChildren(el("p", "empty", "Clean worktree — no changes in this round."))
    return
  }
  pane.replaceChildren(...round.files.map(renderFile))
}

function renderFile(file) {
  const section = el("section", "file")
  const header = el("div", "file-header")
  header.append(el("span", "path", file.path), el("span", `badge ${file.status}`, file.status))
  if (file.binary) header.append(el("span", "badge note", "binary — not shown"))
  if (file.truncated) header.append(el("span", "badge note", "truncated"))
  if (selectedRound !== null && !file.binary) {
    const commentButton = el("button", "file-comment-button", "Comment")
    commentButton.addEventListener("click", () => beginComment("file", { round: selectedRound, file: file.path }))
    header.append(commentButton)
  }
  section.append(header)

  if (openForm !== null && openForm.scope === "file" && openForm.anchor.round === selectedRound && openForm.anchor.file === file.path) {
    section.append(renderCommentForm())
  }

  if (file.binary || file.hunks.length === 0) {
    section.append(el("p", "empty", file.binary ? "Binary content is not rendered." : "No content hunks."))
    return section
  }
  for (const hunk of file.hunks) {
    const box = el("div", "hunk pending")
    box.dataset.filePath = file.path
    box.dataset.hunkIndex = String(hunk.index)
    box.style.minHeight = `${hunk.lines.length * 21 + 24}px`
    section.append(box)
    // A draft anchored to this hunk needs its lines rendered now — the form
    // must mount inline, and lazily-rendered boxes have no rows to anchor to.
    if (formTargetsHunk(file.path, hunk.index)) renderHunkInto(box)
    else hunkObserver.observe(box)
  }
  return section
}

function formTargetsHunk(filePath, hunkIndex) {
  return (
    openForm !== null &&
    openForm.scope === "inline" &&
    openForm.anchor.round === selectedRound &&
    openForm.anchor.file === filePath &&
    openForm.anchor.hunkIndex === hunkIndex
  )
}

function renderHunkInto(box) {
  const round = reviewState.rounds.find((r) => r.n === selectedRound)
  const file = round?.files.find((f) => f.path === box.dataset.filePath)
  const hunk = file?.hunks[Number(box.dataset.hunkIndex)]
  if (!hunk) return
  box.classList.remove("pending")
  box.replaceChildren(el("div", "hunk-header", hunk.header))

  let oldLine = hunk.oldStart
  let newLine = hunk.newStart
  for (const line of hunk.lines) {
    const kind = line.origin === "+" ? "add" : line.origin === "-" ? "del" : "ctx"
    const row = el("div", `diff-line ${kind}`)
    row.dataset.origin = line.origin
    row.dataset.line = String(line.origin === "-" ? oldLine : newLine)
    row.append(
      el("span", "ln", line.origin === "+" ? "" : String(oldLine)),
      el("span", "ln", line.origin === "-" ? "" : String(newLine)),
      el("span", "origin", line.origin),
      el("span", "content", line.content),
    )
    row.addEventListener("click", () => gutterClick(box, row))
    box.append(row)
    if (formTargetsHunk(box.dataset.filePath, hunk.index)) {
      const target = openForm.anchor.lineRange !== undefined && line.origin !== "-" ? newLine : null
      if (target === null || target === openForm.anchor.lineRange[0]) {
        box.append(renderCommentForm())
      }
    }
    if (line.origin !== "+") oldLine++
    if (line.origin !== "-") newLine++
  }
  // Deleted-line clicks have no new-side anchor — the form lands at hunk end.
  if (formTargetsHunk(box.dataset.filePath, hunk.index) && openForm.anchor.lineRange === undefined) {
    box.append(renderCommentForm())
  }
}

// Gutter click (LLD §8): a new-side or context line anchors to that line; a
// deleted line has no new-side number, so it anchors to the hunk without a
// lineRange.
function gutterClick(box, row) {
  if (selectedRound === null) return
  const anchor = {
    round: selectedRound,
    file: box.dataset.filePath,
    hunkIndex: Number(box.dataset.hunkIndex),
  }
  if (row.dataset.origin !== "-") {
    const line = Number(row.dataset.line)
    anchor.lineRange = [line, line]
  }
  beginComment("inline", anchor)
}

function beginComment(scope, anchor) {
  openForm = { scope, anchor, text: openForm?.text ?? "", isLesson: false }
  if (scope === "overall") activeTab = "Comments"
  render()
}

function renderCommentForm() {
  const form = el("div", "comment-form")
  const scopeLabel =
    openForm.scope === "inline"
      ? `inline · ${openForm.anchor.file} · hunk ${openForm.anchor.hunkIndex}`
      : openForm.scope === "file"
        ? `file · ${openForm.anchor.file}`
        : "overall"
  const textarea = el("textarea", "comment-input")
  textarea.placeholder = `Comment (author: human, ${scopeLabel})`
  textarea.value = openForm.text
  textarea.addEventListener("input", () => {
    openForm.text = textarea.value
  })

  const lessonLabel = el("label", "lesson-check")
  const lessonBox = el("input")
  lessonBox.type = "checkbox"
  lessonBox.checked = openForm.isLesson
  lessonBox.addEventListener("change", () => {
    openForm.isLesson = lessonBox.checked
  })
  lessonLabel.append(lessonBox, el("span", undefined, " Mark as lesson"))

  const status = el("span", "form-status")
  const post = el("button", "post-button", "Post")
  post.addEventListener("click", async () => {
    if (openForm.text.trim() === "") {
      status.textContent = "Write something first."
      return
    }
    post.disabled = true
    try {
      const res = await fetch("/api/comments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          author: "human",
          scope: openForm.scope,
          anchor: openForm.anchor,
          body: openForm.text,
          isLesson: openForm.isLesson,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        status.textContent = `Failed (${res.status}): ${body.error ?? "unknown error"}`
        post.disabled = false
        return
      }
      openForm = null
      await refresh()
    } catch (err) {
      status.textContent = `Failed: ${String(err)}`
      post.disabled = false
    }
  })
  const cancel = el("button", "cancel-button", "Cancel")
  cancel.addEventListener("click", () => {
    openForm = null
    render()
  })

  form.append(scopeTag(scopeLabel), textarea, lessonLabel, el("div", "form-actions", [post, cancel, status]))
  return form
}

function scopeTag(label) {
  return el("span", "scope-tag", label)
}

function connectEvents() {
  const source = new EventSource("/api/events")
  // Fires on first connect and every reconnect — the LLD's full-state refetch
  // on reconnect (no incremental sync, the client stays dumb).
  source.onopen = () => {
    reconnectFailures = 0
    setBanner(false)
    refresh()
  }
  source.onerror = () => {
    reconnectFailures++
    if (reconnectFailures >= BANNER_AFTER_FAILURES) setBanner(true)
  }
  for (const name of SSE_EVENTS) {
    source.addEventListener(name, () => refresh())
  }
  // Answers aren't in /api/state (transient) — the event payload carries them.
  // The asking tab already logged it via the HTTP response; the id dedupes.
  source.addEventListener("answer", (event) => {
    const data = JSON.parse(event.data)
    if (qaLog.some((qa) => qa.id === data.id)) return
    qaLog.unshift({ id: data.id, question: data.question, answer: data.answer })
    renderPanel()
  })
}

function setBanner(visible) {
  document.getElementById("reconnect-banner").classList.toggle("hidden", !visible)
}

function el(tag, className, content) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (content !== undefined) {
    if (Array.isArray(content)) node.append(...content)
    else node.textContent = content
  }
  return node
}

document.getElementById("round-select").addEventListener("change", (event) => {
  selectedRound = Number(event.target.value)
  render()
})

document.getElementById("overall-comment").addEventListener("click", () => {
  if (selectedRound === null) return
  beginComment("overall", { round: selectedRound })
})

document.getElementById("submit-review").addEventListener("click", () => {
  activeTab = "Status"
  render()
})

// Side panel (LLD §8): tabs for Analysis, Findings, Comments, Status. Comments
// and Status fill in with later tasks; for now they render empty states.
function renderPanel() {
  document.getElementById("panel-tabs").replaceChildren(
    ...PANEL_TABS.map((tab) => {
      const button = el("button", `tab${tab === activeTab ? " active" : ""}`, tab)
      button.addEventListener("click", () => {
        activeTab = tab
        renderPanel()
      })
      return button
    }),
  )
  document.getElementById("panel-content").replaceChildren(renderTabContent())
}

function renderTabContent() {
  const analysis = selectedRound === null ? null : reviewState.analysis[String(selectedRound)]
  switch (activeTab) {
    case "Analysis":
      return renderAnalysisTab(analysis)
    case "Findings":
      return renderFindingsTab(analysis)
    case "Comments":
      return renderCommentsTab()
    case "Status":
      return renderStatusTab()
    default:
      return el("p", "empty", "Nothing here.")
  }
}

// Status tab: the submit → plan → approve → status → round-consent handoff
// (LLD §8, §5c). Everything renders from the /api/state projection; actions
// post to the token-gated control routes.
function renderStatusTab() {
  const submission = reviewState.submission
  if (submission === null) return renderSubmitCard()
  const wrap = el("div", "status-tab")
  if (submission.plan === null && !submission.planApproved) {
    wrap.append(el("p", "empty", "Planning… the agent is drafting a fix plan."))
  }
  if (submission.plan !== null) wrap.append(renderPlanCard(submission))
  if (submission.planApproved) {
    if (submission.statuses !== null && submission.statuses !== undefined) {
      wrap.append(renderStatusesCard(submission))
    }
    if (submission.stalled) {
      wrap.append(el("p", "degraded", "The session stopped responding (10-minute stall). The review stays usable."))
    }
    if (submission.statusError !== undefined && submission.statusError !== null) {
      wrap.append(el("p", "degraded", `Status report failed: ${submission.statusError}`))
    }
    if (!submission.roundPrompted && (submission.statuses !== null || submission.stalled)) {
      wrap.append(renderRoundConsentCard(submission))
    }
    if (submission.roundPrompted) {
      wrap.append(el("p", "empty", "New round captured — keep reviewing above."))
    }
  }
  return wrap
}

function renderSubmitCard() {
  const card = el("div", "status-card")
  card.append(el("h3", "section-title", "Submit requests"))
  const accepted = reviewState.acceptedFindings
  card.append(
    el(
      "p",
      "hint",
      accepted.length === 0
        ? "Add explicit requests below. Accepted findings from the Findings tab join automatically."
        : `${accepted.length} accepted finding${accepted.length === 1 ? "" : "s"} will join automatically.`,
    ),
  )
  const textarea = el("textarea", "comment-input")
  textarea.placeholder = "One request per line, e.g.\nSplit the render loop\nAdd a test for empty input"
  const post = el("button", "post-button", "Submit to agent")
  post.addEventListener("click", async () => {
    const requests = textarea.value
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
    post.disabled = true
    try {
      const res = await fetch("/api/submit", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${reviewerToken()}` },
        body: JSON.stringify({ requests }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        card.append(el("p", "error-note", `Submit failed (${res.status}): ${body.error ?? "unknown error"}`))
        post.disabled = false
        return
      }
      await refresh()
    } catch (err) {
      card.append(el("p", "error-note", `Submit failed: ${String(err)}`))
      post.disabled = false
    }
  })
  card.append(textarea, post)
  return card
}

function requestText(requestId) {
  const submission = reviewState.submission
  const request = submission?.payload.requests.find((r) => r.id === requestId)
  return request?.text ?? requestId
}

function originTag(origin) {
  return el("span", "scope-tag", origin === "accepted-finding" ? "from accepted finding" : origin)
}

function renderPlanCard(submission) {
  const card = el("div", "status-card plan")
  card.append(el("h3", "section-title", "Fix plan"))
  for (const entry of submission.plan.perRequest) {
    const row = el("div", "plan-row")
    row.append(
      el("p", "plan-request", [
        originTag(submission.payload.requests.find((r) => r.id === entry.requestId)?.origin ?? "user"),
        el("span", undefined, requestText(entry.requestId)),
      ]),
      el("p", "purpose", entry.approach),
      el("p", "finding-where", entry.affectedFiles.length > 0 ? entry.affectedFiles.join(", ") : "no files listed"),
    )
    card.append(row)
  }
  const approve = el("button", "post-button", "Approve plan — authorize edits")
  approve.addEventListener("click", async () => {
    approve.disabled = true
    try {
      const res = await fetch("/api/plan/approve", {
        method: "POST",
        headers: { authorization: `Bearer ${reviewerToken()}` },
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        card.append(el("p", "error-note", `Approve failed (${res.status}): ${body.error ?? "unknown error"}`))
        approve.disabled = false
        return
      }
      await refresh()
    } catch (err) {
      card.append(el("p", "error-note", `Approve failed: ${String(err)}`))
      approve.disabled = false
    }
  })
  card.append(approve)
  return card
}

function renderStatusesCard(submission) {
  const card = el("div", "status-card")
  card.append(el("h3", "section-title", "Status report"))
  for (const status of submission.statuses) {
    const row = el("div", "plan-row")
    row.append(
      el("p", "plan-request", [
        statusBadge(status.status),
        el("span", undefined, requestText(status.requestId)),
      ]),
      el("p", "purpose", status.reason),
    )
    for (const check of status.checks ?? []) {
      row.append(el("p", "check-row", `${check.passed ? "✓" : "✗"} ${check.command} — ${check.summary}`))
    }
    card.append(row)
  }
  return card
}

function statusBadge(status) {
  return el("span", `badge status-${status}`, status)
}

function renderRoundConsentCard(submission) {
  const card = el("div", "status-card consent")
  const nextRound = reviewState.rounds.length + 1
  card.append(
    el("h3", "section-title", `Capture round ${nextRound}?`),
    el("p", "hint", "Snapshots the current worktree diff as a new round for fresh analysis and comments."),
  )
  const capture = el("button", "post-button", `Capture round ${nextRound}`)
  capture.addEventListener("click", async () => {
    capture.disabled = true
    try {
      const res = await fetch("/api/rounds", {
        method: "POST",
        headers: { authorization: `Bearer ${reviewerToken()}` },
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        card.append(el("p", "error-note", `Capture failed (${res.status}): ${body.error ?? "unknown error"}`))
        capture.disabled = false
        return
      }
      await refresh()
    } catch (err) {
      card.append(el("p", "error-note", `Capture failed: ${String(err)}`))
      capture.disabled = false
    }
  })
  card.append(capture)
  return card
}

// Comments tab: the overall-scope draft (opened from the header), the Q&A ask
// box with this tab's seen answers, and the selected round's comments with
// author attribution (LLD §4, §8).
function renderCommentsTab() {
  const wrap = el("div", "comments-tab")
  if (openForm !== null && openForm.scope === "overall") wrap.append(renderCommentForm())
  wrap.append(renderAskBox())
  for (const qa of qaLog) {
    const card = el("div", "qa-card")
    card.append(el("p", "qa-question", `Q: ${qa.question}`), el("p", "qa-answer", `A: ${qa.answer}`))
    wrap.append(card)
  }
  const comments = reviewState.comments
    .filter((c) => c.anchor.round === selectedRound)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  if (comments.length === 0 && qaLog.length === 0) {
    wrap.append(el("p", "empty", "No comments or answers yet — click a diff line to comment."))
  }
  for (const comment of comments) {
    const card = el("div", `comment-card${comment.isLesson ? " lesson" : ""}`)
    const where =
      comment.scope === "overall"
        ? "overall"
        : comment.scope === "file"
          ? comment.anchor.file
          : `${comment.anchor.file} · hunk ${comment.anchor.hunkIndex}${comment.anchor.lineRange !== undefined ? ` · lines ${comment.anchor.lineRange[0]}-${comment.anchor.lineRange[1]}` : ""}`
    card.append(
      el("div", "comment-head", [
        el("span", "comment-author", comment.author),
        el("span", "scope-tag", comment.scope),
        el("span", "comment-where", where),
        ...(comment.isLesson ? [el("span", "badge lesson-badge", "lesson")] : []),
      ]),
      el("p", "comment-body", comment.body),
    )
    wrap.append(card)
  }
  return wrap
}

function renderAskBox() {
  const box = el("div", "ask-box")
  const input = el("input", "ask-input")
  input.placeholder = "Ask the reviewing agent a question…"
  const ask = el("button", "ask-button", "Ask")
  ask.addEventListener("click", async () => {
    if (input.value.trim() === "") return
    ask.disabled = true
    ask.textContent = "Asking…"
    try {
      const res = await fetch("/api/questions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ author: "human", question: input.value }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || body.answer === undefined) {
        qaLog.unshift({ question: input.value, answer: `Ask failed (${res.status}): ${body.error ?? "unknown"}` })
      } else if (!qaLog.some((qa) => qa.id === body.id)) {
        // the SSE event may arrive before this HTTP response (broadcast fires
        // first server-side) — only one of the two paths logs each answer
        qaLog.unshift({ id: body.id, question: input.value, answer: body.answer })
      }
      input.value = ""
      renderPanel()
    } finally {
      ask.disabled = false
      ask.textContent = "Ask"
    }
  })
  box.append(input, ask)
  return box
}

function renderAnalysisTab(analysis) {
  if (!analysis) return el("p", "empty", "No analysis yet for this round.")
  const wrap = el("div", "analysis")
  if (analysis.unparsed) {
    const pane = el("section", "unparsed")
    pane.append(el("h3", "section-title", "Unparsed analysis"), el("pre", "raw", analysis.unparsed))
    wrap.append(pane)
  }
  if (analysis.files.length > 0) {
    const section = el("section")
    section.append(el("h3", "section-title", "Files"))
    for (const file of analysis.files) {
      const card = el("div", "analysis-card")
      card.append(
        el("div", "analysis-head", [
          el("span", "path", file.file),
          confidenceBadge(file.confidence),
        ]),
        el("p", "purpose", file.purpose),
      )
      card.append(citations(file.citations))
      section.append(card)
    }
    wrap.append(section)
  }
  if (analysis.hunks.length > 0) {
    const section = el("section")
    section.append(el("h3", "section-title", "Hunks"))
    for (const hunk of analysis.hunks) {
      const card = el("div", "analysis-card")
      card.append(
        el("div", "analysis-head", [
          el("span", "path", `${hunk.file} · hunk ${hunk.hunkIndex}`),
          confidenceBadge(hunk.confidence),
        ]),
        el("p", "purpose", hunk.rationale),
      )
      card.append(citations(hunk.citations))
      section.append(card)
    }
    wrap.append(section)
  }
  return wrap
}

// Findings are the visually distinct section (LLD §8): each carries an
// accept-as-request control that posts to the token-gated accept route.
function renderFindingsTab(analysis) {
  if (!analysis) return el("p", "empty", "No analysis yet for this round.")
  if (analysis.findings.length === 0) return el("p", "empty", "No findings for this round.")
  const wrap = el("div", "findings")
  for (const finding of analysis.findings) {
    const accepted = reviewState.acceptedFindings.some(
      (a) => a.round === selectedRound && a.findingId === finding.id,
    )
    const card = el("div", `finding-card${accepted ? " accepted" : ""}`)
    const head = el("div", "analysis-head", [
      el("span", "finding-id", finding.id),
      accepted ? el("span", "badge accepted-badge", "accepted") : el("span", "badge note", "finding"),
    ])
    card.append(head, el("p", "purpose", finding.claim))
    card.append(citations(finding.citations))
    const where = [finding.file, finding.hunkIndex !== undefined ? `hunk ${finding.hunkIndex}` : null]
      .filter(Boolean)
      .join(" · ")
    if (where) card.append(el("p", "finding-where", where))

    if (!accepted) {
      const accept = el("button", "accept-button", "Accept as request")
      accept.addEventListener("click", () => acceptFinding(finding.id, card))
      card.append(accept)
    }
    wrap.append(card)
  }
  return wrap
}

async function acceptFinding(findingId, card) {
  try {
    const res = await fetch("/api/findings/accept", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${reviewerToken()}`,
      },
      body: JSON.stringify({ round: selectedRound, findingId }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      showPanelNote(card, `Accept failed (${res.status}): ${body.error ?? "unknown error"}`)
      return
    }
    await refresh()
  } catch (err) {
    showPanelNote(card, `Accept failed: ${String(err)}`)
  }
}

function showPanelNote(card, message) {
  card.append(el("p", "error-note", message))
}

function reviewerToken() {
  return new URLSearchParams(window.location.search).get("reviewer") ?? ""
}

function confidenceBadge(confidence) {
  return el("span", `confidence ${confidence === "evidence" ? "evidence" : "inference"}`, confidence)
}

function citations(list) {
  const wrap = el("div", "citations")
  if (list.length === 0) return wrap
  for (const citation of list) {
    wrap.append(el("span", "citation", `"${citation.quote}" — ${citation.source}`))
  }
  return wrap
}

refresh()
connectEvents()