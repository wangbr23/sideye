const SSE_EVENTS = ["analysis.pending", "analysis.update", "analysis.failed", "answer", "plan.pending", "plan.ready", "plan.failed", "status.ready", "round.prompt"]
const BANNER_AFTER_FAILURES = 3

let reviewState = null
let selectedRound = null
let reconnectFailures = 0
let openForm = null // { scope, anchor, text, isLesson }
let qaLog = []
let submitInFlight = false
let submitError = null
let drawerOpen = false
let expandedAnalysis = new Set() // file paths with expanded analysis

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

// ── Refresh + render ──

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
  syncSubmitButton()
  renderTargetLabel()
  renderRoundSelector()
  renderFileNav()
  renderDiff()
  renderActionBar()
}

// ── Header ──

function renderTargetLabel() {
  const label = document.getElementById("target-label")
  const target = reviewState.target
  if (target.kind === "worktree") {
    label.innerHTML = ""
    label.append("worktree changes vs ", codeEl("HEAD"))
  } else {
    label.innerHTML = ""
    label.append("commit ", codeEl(target.sha.slice(0, 10)), " vs first parent")
  }
}

function codeEl(text) {
  const code = document.createElement("code")
  code.textContent = text
  return code
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

function syncSubmitButton() {
  const button = document.getElementById("submit-review")
  if (!button) return
  const submitted = reviewState?.submissions?.some((cycle) => cycle.round === reviewState.rounds.at(-1)?.n) ?? false
  button.disabled = submitInFlight || submitted
  button.textContent = submitInFlight ? "Submitting…" : submitted ? "Submitted" : "Submit"
}

// ── File navigation ──

function renderFileNav() {
  const nav = document.getElementById("file-nav")
  const header = nav.querySelector(".file-nav-header")
  const round = reviewState.rounds.find((r) => r.n === selectedRound)
  const existing = nav.querySelectorAll(".file-nav-item")
  for (const item of existing) item.remove()

  if (!round) return
  const analysis = reviewState.analysis[String(selectedRound)]

  for (const file of round.files) {
    const item = el("div", "file-nav-item")
    item.dataset.filePath = file.path

    const name = el("span", "file-nav-name", file.path.split("/").pop())
    name.title = file.path
    item.append(name)

    const badges = el("div", "file-nav-badges")
    const statusLetter = file.status === "modified" ? "M" : file.status === "added" ? "A" : file.status === "deleted" ? "D" : file.status === "renamed" ? "R" : "U"
    badges.append(el("span", `file-nav-badge st-${file.status}`, statusLetter))

    const commentCount = reviewState.comments.filter(
      (c) => c.anchor.round === selectedRound && c.anchor.file === file.path,
    ).length
    const findingCount = analysis?.findings?.filter(
      (f) => f.file === file.path,
    ).length ?? 0
    if (commentCount > 0) badges.append(el("span", "file-nav-badge count", String(commentCount)))
    if (findingCount > 0) badges.append(el("span", "file-nav-badge count", "!"))

    item.append(badges)
    item.addEventListener("click", () => {
      const target = document.getElementById(`file-${cssId(file.path)}`)
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" })
    })
    nav.append(item)
  }
  updateFileNavActive()
}

function cssId(path) {
  return path.replace(/[^a-zA-Z0-9]/g, "-")
}

function updateFileNavActive() {
  const pane = document.querySelector(".diff-pane")
  const sections = pane.querySelectorAll(".file-section")
  let current = null
  for (const section of sections) {
    const rect = section.getBoundingClientRect()
    if (rect.top <= 120) current = section
  }
  const navItems = document.querySelectorAll(".file-nav-item")
  const currentPath = current?.dataset.filePath
  for (const item of navItems) {
    item.classList.toggle("active", item.dataset.filePath === currentPath)
  }
}

// ── Diff rendering ──

function renderDiff() {
  const pane = document.getElementById("diff-pane")
  const round = reviewState.rounds.find((r) => r.n === selectedRound)

  // Overall comment form and Q&A at the top of the diff
  const topElements = []
  const analysisState = renderAnalysisState(round)
  if (analysisState !== null) topElements.push(analysisState)
  const unparsed = renderUnparsedAnalysis(round)
  if (unparsed !== null) topElements.push(unparsed)
  if (openForm !== null && openForm.scope === "overall") {
    topElements.push(renderCommentForm("overall"))
  }
  topElements.push(renderAskBox())
  for (const qa of qaLog) {
    const card = el("div", "qa-card overall-qa")
    card.append(el("p", "qa-question", `Q: ${qa.question}`), el("p", "qa-answer", `A: ${qa.answer}`))
    topElements.push(card)
  }

  if (!round) {
    pane.replaceChildren(...topElements, el("p", "empty", "No rounds captured yet."))
    return
  }
  if (round.files.length === 0) {
    pane.replaceChildren(...topElements, el("p", "empty", "Clean worktree — no changes in this round."))
    return
  }
  pane.replaceChildren(...topElements, ...round.files.map(renderFile))
}

function renderAnalysisState(round) {
  if (!round || reviewState.analysis[String(round.n)]) return null

  const status = reviewState.analysisStatus?.[String(round.n)]
  const notice = el("div", `analysis-state ${status === "failed" ? "failed" : "loading"}`)
  notice.setAttribute("role", "status")

  if (status === "failed") {
    notice.append(
      el("strong", "analysis-state-title", "Analysis could not be loaded"),
      el("span", "analysis-state-detail", "The diff is still available to review."),
    )
  } else if (!reviewState.sessionLinked) {
    notice.className = "analysis-state failed"
    notice.append(
      el("strong", "analysis-state-title", "Analysis is unavailable"),
      el("span", "analysis-state-detail", "No agent session is linked to this review."),
    )
  } else {
    notice.append(
      el("span", "loading-spinner", ""),
      el("strong", "analysis-state-title", "Analyzing changes"),
      el("span", "analysis-state-detail", "File explanations and findings are loading. You can review the diff now."),
    )
  }
  return notice
}

function renderUnparsedAnalysis(round) {
  if (!round) return null
  const text = reviewState.analysis[String(round.n)]?.unparsed
  if (typeof text !== "string" || text.trim() === "") return null

  const unparsed = el("div", "unparsed-block")
  unparsed.append(
    el("div", "unparsed-label", "Unparsed analysis"),
    el("pre", "unparsed-text", text),
  )
  return unparsed
}

function renderFile(file) {
  const section = el("section", "file-section")
  section.id = `file-${cssId(file.path)}`
  section.dataset.filePath = file.path

  // File header
  const header = el("div", "file-header")
  header.append(
    el("span", "file-path", file.path),
    el("span", `file-status ${file.status}`, file.status),
  )
  if (file.binary) header.append(el("span", "file-status", "binary"))
  if (file.truncated) header.append(el("span", "file-status", "truncated"))

  const actions = el("div", "file-actions")
  if (selectedRound !== null && !file.binary) {
    const commentBtn = el("button", "btn btn-sm", "Comment")
    commentBtn.addEventListener("click", () => beginComment("file", { round: selectedRound, file: file.path }))
    actions.append(commentBtn)
  }
  header.append(actions)
  section.append(header)

  // Analysis summary (collapsible)
  const analysis = reviewState.analysis[String(selectedRound)]
  const fileAnalysis = analysis?.files?.find((f) => f.file === file.path)
  if (fileAnalysis) {
    const isExpanded = expandedAnalysis.has(file.path)

    const summary = el("div", "file-analysis-summary")
    const toggle = el("span", `analysis-toggle${isExpanded ? " open" : ""}`, "▶")
    const purposeText = el("span", "analysis-purpose-text", fileAnalysis.purpose)
    const badge = el("span", `confidence-badge ${fileAnalysis.confidence}`, fileAnalysis.confidence)
    summary.append(toggle, purposeText, badge)
    summary.addEventListener("click", () => {
      if (expandedAnalysis.has(file.path)) expandedAnalysis.delete(file.path)
      else expandedAnalysis.add(file.path)
      render()
    })
    section.append(summary)

    if (isExpanded) {
      const detail = el("div", "analysis-detail")
      const hunkAnalyses = analysis?.hunks?.filter((h) => h.file === file.path) ?? []
      if (hunkAnalyses.length === 0) {
        detail.append(el("p", "analysis-rationale", "No per-hunk analysis available."))
      }
      for (const ha of hunkAnalyses) {
        const item = el("div", "analysis-hunk-item")
        item.append(
          el("div", "analysis-hunk-label", `Hunk ${ha.hunkIndex}`),
          el("div", "analysis-rationale", ha.rationale),
        )
        if (ha.citations?.length > 0) {
          item.append(renderCitations(ha.citations))
        }
        detail.append(item)
      }
      if (fileAnalysis.citations?.length > 0) {
        const fileCitations = el("div", "analysis-hunk-item")
        fileCitations.append(
          el("div", "analysis-hunk-label", "File-level citations"),
          renderCitations(fileAnalysis.citations),
        )
        detail.append(fileCitations)
      }
      section.append(detail)
    }
  }

  // File-scope comment form
  if (openForm !== null && openForm.scope === "file" && openForm.anchor.round === selectedRound && openForm.anchor.file === file.path) {
    section.append(renderCommentForm())
  }

  // File-scope comments
  const fileComments = reviewState.comments
    .filter((c) => c.scope === "file" && c.anchor.round === selectedRound && c.anchor.file === file.path)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  for (const comment of fileComments) {
    section.append(renderInlineComment(comment))
  }

  // File-level findings (no specific hunk)
  const fileFindings = analysis?.findings?.filter(
    (f) => f.file === file.path && f.hunkIndex === undefined,
  ) ?? []
  for (const finding of fileFindings) {
    section.append(renderInlineFinding(finding))
  }

  if (file.binary || file.hunks.length === 0) {
    section.append(el("p", "file-empty", file.binary ? "Binary content is not rendered." : "No content hunks."))
    return section
  }

  for (const hunk of file.hunks) {
    const box = el("div", "hunk pending")
    box.dataset.filePath = file.path
    box.dataset.hunkIndex = String(hunk.index)
    box.style.minHeight = `${hunk.lines.length * 22 + 28}px`
    section.append(box)
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
  const hunkIndex = Number(box.dataset.hunkIndex)
  const hunk = file?.hunks[hunkIndex]
  if (!hunk) return

  const byLine = new Map()
  const unanchored = []
  for (const comment of reviewState.comments) {
    if (comment.scope !== "inline") continue
    if (comment.anchor.round !== selectedRound) continue
    if (comment.anchor.file !== box.dataset.filePath) continue
    if (comment.anchor.hunkIndex !== hunkIndex) continue
    if (comment.anchor.lineRange === undefined) unanchored.push(comment)
    else {
      const start = comment.anchor.lineRange[0]
      if (!byLine.has(start)) byLine.set(start, [])
      byLine.get(start).push(comment)
    }
  }
  for (const group of byLine.values()) group.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  unanchored.sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  // Hunk-level findings
  const analysis = reviewState.analysis[String(selectedRound)]
  const hunkFindings = analysis?.findings?.filter(
    (f) => f.file === box.dataset.filePath && f.hunkIndex === hunkIndex,
  ) ?? []

  box.classList.remove("pending")
  box.replaceChildren(el("div", "hunk-header", hunk.header))

  let oldLine = hunk.oldStart
  let newLine = hunk.newStart
  let formPlaced = false
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
    if (line.origin !== "-" && byLine.has(newLine)) {
      box.append(...byLine.get(newLine).map(renderInlineComment))
    }
    if (
      !formPlaced &&
      formTargetsHunk(box.dataset.filePath, hunkIndex) &&
      openForm.anchor.lineRange !== undefined &&
      line.origin !== "-" &&
      newLine === openForm.anchor.lineRange[0]
    ) {
      box.append(renderCommentForm())
      formPlaced = true
    }
    if (line.origin !== "+") oldLine++
    if (line.origin !== "-") newLine++
  }
  if (!formPlaced && formTargetsHunk(box.dataset.filePath, hunkIndex)) {
    box.append(renderCommentForm())
  }
  for (const comment of unanchored) box.append(renderInlineComment(comment))

  // Render findings at the end of the hunk
  for (const finding of hunkFindings) {
    box.append(renderInlineFinding(finding))
  }
}

// ── Inline comments ──

function renderInlineComment(comment) {
  const card = el("div", `inline-comment${comment.isLesson ? " lesson" : ""}`)
  const head = el("div", "comment-head")
  head.append(
    el("span", "comment-author", comment.author),
    el("span", "comment-scope", commentScopeLabel(comment)),
  )
  if (comment.isLesson) head.append(el("span", "lesson-badge", "lesson"))
  const actions = el("div", "comment-actions")
  actions.append(deleteButton(comment))
  head.append(actions)
  card.append(head, el("p", "comment-body", comment.body))
  return card
}

function commentScopeLabel(comment) {
  if (comment.scope === "overall") return "overall"
  if (comment.scope === "file") return comment.anchor.file ?? ""
  if (comment.anchor.lineRange !== undefined) return `line ${comment.anchor.lineRange[0]}`
  return `hunk ${comment.anchor.hunkIndex}`
}

function deleteButton(comment) {
  const button = el("button", "btn-danger", "Delete")
  button.addEventListener("click", (e) => {
    e.stopPropagation()
    deleteComment(comment.id, button)
  })
  return button
}

async function deleteComment(commentId, button) {
  const card = button.closest(".inline-comment")
  if (!window.confirm("Delete this comment?")) return
  button.disabled = true
  try {
    const res = await fetch("/api/comments/delete", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${reviewerToken()}`,
      },
      body: JSON.stringify({ id: commentId }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      card?.append(el("p", "error-note", `Delete failed (${res.status}): ${body.error ?? "unknown error"}`))
      button.disabled = false
      return
    }
    await refresh()
  } catch (err) {
    card?.append(el("p", "error-note", `Delete failed: ${String(err)}`))
    button.disabled = false
  }
}

// ── Inline findings ──

function renderInlineFinding(finding) {
  const accepted = reviewState.acceptedFindings.some(
    (a) => a.round === selectedRound && a.findingId === finding.id,
  )
  const card = el("div", `inline-finding${accepted ? " accepted" : ""}`)
  const head = el("div", "finding-head")
  head.append(
    el("span", "finding-id", finding.id),
    el("span", `finding-label ${accepted ? "accepted-label" : "pending"}`, accepted ? "accepted" : "finding"),
  )
  card.append(head)
  card.append(el("p", "finding-claim", finding.claim))

  if (finding.citations?.length > 0) {
    card.append(renderCitations(finding.citations))
  }

  if (!accepted) {
    const actions = el("div", "finding-actions")
    const acceptBtn = el("button", "finding-accept-btn", "Accept as request")
    acceptBtn.addEventListener("click", () => acceptFinding(finding.id, card))
    actions.append(acceptBtn)
    card.append(actions)
  }
  return card
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
      card.append(el("p", "error-note", `Accept failed (${res.status}): ${body.error ?? "unknown error"}`))
      return
    }
    await refresh()
  } catch (err) {
    card.append(el("p", "error-note", `Accept failed: ${String(err)}`))
  }
}

// ── Comment forms ──

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
  render()
}

function renderCommentForm(extraClass) {
  const form = el("div", `comment-form${extraClass ? ` ${extraClass}` : ""}`)
  const scopeLabel =
    openForm.scope === "inline"
      ? `inline · ${openForm.anchor.file} · hunk ${openForm.anchor.hunkIndex}`
      : openForm.scope === "file"
        ? `file · ${openForm.anchor.file}`
        : "overall"
  form.append(el("span", "scope-tag", scopeLabel))

  const textarea = el("textarea", "comment-input")
  textarea.placeholder = "Add a comment…"
  textarea.value = openForm.text
  textarea.addEventListener("input", () => { openForm.text = textarea.value })

  const lessonLabel = el("label", "lesson-check")
  const lessonBox = el("input")
  lessonBox.type = "checkbox"
  lessonBox.checked = openForm.isLesson
  lessonBox.addEventListener("change", () => { openForm.isLesson = lessonBox.checked })
  lessonLabel.append(lessonBox, " Mark as lesson")

  const status = el("span", "form-status")
  const post = el("button", "btn btn-primary btn-sm", "Post")
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
  const cancel = el("button", "btn btn-sm", "Cancel")
  cancel.addEventListener("click", () => { openForm = null; render() })

  const actions = el("div", "form-actions")
  actions.append(lessonLabel)
  const right = el("div", "form-actions-right")
  right.append(cancel, post, status)
  actions.append(right)
  form.append(textarea, actions)
  return form
}

// ── Q&A ──

function renderAskBox() {
  const box = el("div", "ask-box")
  const input = el("input", "ask-input")
  input.placeholder = "Ask the reviewing agent a question…"
  const ask = el("button", "btn btn-sm", "Ask")
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
        qaLog.unshift({ id: body.id, question: input.value, answer: body.answer })
      }
      input.value = ""
      render()
    } finally {
      ask.disabled = false
      ask.textContent = "Ask"
    }
  })
  box.append(input, ask)
  return box
}

// ── Action bar (submit / plan / status / consent) ──

function renderActionBar() {
  const bar = document.getElementById("action-bar")
  const summaryEl = document.getElementById("action-bar-summary")
  const drawerEl = document.getElementById("action-drawer")
  const submission = reviewState.submission

  if (submission === null || submission.roundPrompted) {
    renderSubmitBar(bar, summaryEl, drawerEl)
    return
  }

  bar.hidden = false

  if (submission.planning) {
    renderPlanningBar(summaryEl, drawerEl, submission)
  } else if (submission.planError) {
    renderPlanErrorBar(summaryEl, drawerEl, submission)
  } else if (submission.plan && !submission.planApproved) {
    renderPlanReadyBar(summaryEl, drawerEl, submission)
  } else if (submission.planApproved && submission.statuses) {
    renderStatusBar(summaryEl, drawerEl, submission)
  } else if (submission.planApproved && submission.stalled) {
    renderStalledBar(summaryEl, drawerEl)
  } else if (submission.planApproved && submission.statusError) {
    renderFixErrorBar(summaryEl, drawerEl, submission)
  } else if (submission.planApproved) {
    renderWorkingBar(summaryEl)
    drawerEl.className = "action-drawer"
    drawerEl.replaceChildren()
  } else if (!reviewState.sessionLinked) {
    summaryEl.replaceChildren(
      el("span", "action-bar-state", "No agent session linked"),
      el("span", "action-bar-detail", "Relaunch the review from the agent session"),
    )
    drawerEl.className = "action-drawer"
    drawerEl.replaceChildren()
  } else {
    summaryEl.replaceChildren(el("span", "action-bar-state", "Submitted"))
    drawerEl.className = "action-drawer"
    drawerEl.replaceChildren()
  }
}

function renderSubmitBar(bar, summaryEl, drawerEl) {
  const accepted = reviewState.acceptedFindings
  const commentCount = reviewState.comments.length
  const hasContent = accepted.length > 0 || commentCount > 0

  bar.hidden = false

  const parts = []
  if (commentCount > 0) parts.push(`${commentCount} comment${commentCount === 1 ? "" : "s"}`)
  if (accepted.length > 0) parts.push(`${accepted.length} finding${accepted.length === 1 ? "" : "s"} accepted`)

  summaryEl.replaceChildren(
    el("span", "action-bar-state", hasContent ? "Ready to submit" : "Review in progress"),
    el("span", "action-bar-detail", parts.length > 0 ? parts.join(", ") + " will be sent" : "Add comments or accept findings to submit"),
  )
  summaryEl.onclick = () => {
    drawerEl.classList.toggle("open")
    drawerOpen = drawerEl.classList.contains("open")
  }

  const content = el("div", "submit-card")
  content.append(
    el("p", "submit-hint", "Typed requests (one per line). Your comments and accepted findings join automatically."),
  )
  const textarea = el("textarea", "comment-input")
  textarea.id = "submit-textarea"
  textarea.placeholder = "Split the render loop\nAdd a test for empty input"
  const submitBtn = el("button", "btn btn-primary", "Submit to agent")
  submitBtn.addEventListener("click", async () => {
    const requests = textarea.value
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
    submitBtn.disabled = true
    submitInFlight = true
    syncSubmitButton()
    let error = null
    try {
      error = await postSubmit(requests)
    } catch (err) {
      error = `Submit failed: ${String(err)}`
    }
    submitInFlight = false
    if (error !== null) {
      content.append(el("p", "error-note", error))
      submitBtn.disabled = false
      syncSubmitButton()
      return
    }
    drawerOpen = false
    await refresh()
  })
  content.append(textarea, submitBtn)
  if (reviewState.submissions?.length > 0) content.append(renderCycleHistory())
  if (submitError !== null) content.append(el("p", "error-note", submitError))

  drawerEl.className = `action-drawer${drawerOpen ? " open" : ""}`
  drawerEl.replaceChildren(content)
}

function renderPlanningBar(summaryEl, drawerEl, submission) {
  const count = submission.payload.requests.length
  summaryEl.replaceChildren(
    el("span", "action-bar-state", `Planning… ${count} item${count === 1 ? "" : "s"}`),
    el("span", "action-bar-detail", `session: ${reviewState.sessionID}`),
  )
  summaryEl.onclick = () => {
    drawerEl.classList.toggle("open")
    drawerOpen = drawerEl.classList.contains("open")
  }

  const content = el("div", "drawer-content")
  content.append(el("div", "drawer-section-title", "Submitted items"))
  for (const request of submission.payload.requests) {
    content.append(renderPlanItem(request, submission))
  }
  drawerEl.className = `action-drawer${drawerOpen ? " open" : ""}`
  drawerEl.replaceChildren(content)
}

function renderPlanErrorBar(summaryEl, drawerEl, submission) {
  summaryEl.replaceChildren(el("span", "action-bar-state", "Plan failed"))

  const right = el("div", "action-bar-right")
  const retry = el("button", "btn btn-primary btn-sm", "Retry plan")
  retry.addEventListener("click", async () => {
    retry.disabled = true
    try {
      const res = await fetch("/api/plan/retry", {
        method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${reviewerToken()}` },
      body: JSON.stringify({ cycle: submission.cycle, version: submission.version }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        summaryEl.append(el("p", "error-note", `Retry failed (${res.status}): ${body.error ?? "unknown error"}`))
        retry.disabled = false
        return
      }
      await refresh()
    } catch (err) {
      summaryEl.append(el("p", "error-note", `Retry failed: ${String(err)}`))
      retry.disabled = false
    }
  })
  right.append(retry)
  const cycle = reviewState.submissions?.find((item) => item.n === submission.cycle)
  const fallback = [...(cycle?.plans ?? [])].reverse().find((plan) => plan.status === "ready")
  if (fallback) {
    const approve = el("button", "btn btn-sm", `Approve v${fallback.n} — newer feedback stays queued`)
    approve.addEventListener("click", async () => {
      approve.disabled = true
      const res = await fetch("/api/plan/approve", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${reviewerToken()}` },
        body: JSON.stringify({ cycle: cycle.n, version: fallback.n }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        summaryEl.append(el("p", "error-note", `Approve failed (${res.status}): ${body.error ?? "unknown error"}`))
        approve.disabled = false
        return
      }
      await refresh()
    })
    right.append(approve)
  }
  summaryEl.append(el("span", "action-bar-detail", submission.planError), right)

  drawerEl.className = "action-drawer"
  drawerEl.replaceChildren()
}

function renderPlanReadyBar(summaryEl, drawerEl, submission) {
  const count = submission.plan.perRequest.length
  const queued = queuedCommentCount(submission.payload)
  const right = el("div", "action-bar-right")
  const approveBtn = el("button", "btn btn-primary btn-sm", queued ? `Approve plan — ${queued} comment${queued === 1 ? "" : "s"} stay queued` : "Approve plan — authorize edits")
  approveBtn.addEventListener("click", async () => {
    approveBtn.disabled = true
    try {
      const res = await fetch("/api/plan/approve", {
        method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${reviewerToken()}` },
      body: JSON.stringify({ cycle: submission.cycle, version: submission.version }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        summaryEl.append(el("p", "error-note", `Approve failed (${res.status}): ${body.error ?? "unknown error"}`))
        approveBtn.disabled = false
        return
      }
      drawerOpen = false
      await refresh()
    } catch (err) {
      summaryEl.append(el("p", "error-note", `Approve failed: ${String(err)}`))
      approveBtn.disabled = false
    }
  })
  right.append(approveBtn)

  summaryEl.replaceChildren(
    el("span", "action-bar-state", "Plan ready"),
    el("span", "action-bar-detail", `${count} item${count === 1 ? "" : "s"}`),
    right,
  )
  summaryEl.onclick = (e) => {
    if (e.target.closest(".btn")) return
    drawerEl.classList.toggle("open")
    drawerOpen = drawerEl.classList.contains("open")
  }

  const content = el("div", "drawer-content")
  content.append(el("div", "drawer-section-title", `Fix plan v${submission.version} · ${count} covered items`))
  for (const entry of submission.plan.perRequest) {
    const request = submission.payload.requests.find((r) => r.id === entry.requestId)
    const item = el("div", "plan-item")
    const header = el("div", "plan-item-header")
    header.append(
      originTag(request?.origin ?? "user", request?.comment?.author),
      el("span", "plan-item-text", requestText(entry.requestId)),
    )
    item.append(header)
    item.append(el("p", "plan-item-approach", entry.approach))
    if (entry.affectedFiles.length > 0) {
      item.append(el("p", "plan-item-files", entry.affectedFiles.join(", ")))
    }
    content.append(item)
  }
  const feedback = el("textarea", "comment-input")
  feedback.placeholder = "Explain what should change in the plan (optional if new comments are queued)"
  const revise = el("button", "btn btn-sm", "Request revised plan")
  revise.addEventListener("click", async () => {
    revise.disabled = true
    const res = await fetch("/api/plan/revise", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${reviewerToken()}` },
      body: JSON.stringify({ feedback: feedback.value.trim() || undefined }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      content.append(el("p", "error-note", `Revision failed (${res.status}): ${body.error ?? "unknown error"}`))
      revise.disabled = false
      return
    }
    await refresh()
  })
  content.append(feedback, revise, renderCycleHistory())

  drawerEl.className = `action-drawer${drawerOpen ? " open" : ""}`
  drawerEl.replaceChildren(content)
}

function renderStatusBar(summaryEl, drawerEl, submission) {
  const statuses = submission.statuses
  const addressed = statuses.filter((s) => s.status === "addressed").length
  const total = statuses.length

  const right = el("div", "action-bar-right")
  if (!submission.roundPrompted && (submission.statuses || submission.stalled)) {
    const nextRound = reviewState.rounds.length + 1
    const captureBtn = el("button", "btn btn-primary btn-sm", `Capture round ${nextRound}`)
    captureBtn.addEventListener("click", async () => {
      captureBtn.disabled = true
      try {
        const res = await fetch("/api/rounds", {
          method: "POST",
          headers: { authorization: `Bearer ${reviewerToken()}` },
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          summaryEl.append(el("p", "error-note", `Capture failed (${res.status}): ${body.error ?? "unknown error"}`))
          captureBtn.disabled = false
          return
        }
        drawerOpen = false
        await refresh()
      } catch (err) {
        summaryEl.append(el("p", "error-note", `Capture failed: ${String(err)}`))
        captureBtn.disabled = false
      }
    })
    right.append(captureBtn)
  }
  if (submission.roundPrompted) {
    right.append(el("span", "action-bar-detail", "New round captured"))
  }

  summaryEl.replaceChildren(
    el("span", "action-bar-state", `Status: ${addressed}/${total} addressed`),
    right,
  )
  summaryEl.onclick = (e) => {
    if (e.target.closest(".btn")) return
    drawerEl.classList.toggle("open")
    drawerOpen = drawerEl.classList.contains("open")
  }

  const content = el("div", "drawer-content")
  content.append(el("div", "drawer-section-title", "Status report"))

  if (submission.stalled) {
    content.append(el("p", "degraded-note", "The session stopped responding (10-minute stall). The review stays usable."))
  }
  if (submission.statusError) {
    content.append(el("p", "degraded-note", `Status report failed: ${submission.statusError}`))
  }

  for (const status of statuses) {
    const item = el("div", "plan-item")
    const header = el("div", "plan-item-header")
    header.append(
      el("span", `status-badge ${status.status}`, status.status),
      el("span", "plan-item-text", requestText(status.requestId)),
    )
    item.append(header)
    item.append(el("p", "plan-item-approach", status.reason))
    for (const check of status.checks ?? []) {
      item.append(el("p", "check-row", `${check.passed ? "✓" : "✗"} ${check.command} — ${check.summary}`))
    }
    content.append(item)
  }

  drawerEl.className = `action-drawer${drawerOpen ? " open" : ""}`
  drawerEl.replaceChildren(content)
}

function renderStalledBar(summaryEl, drawerEl) {
  const right = el("div", "action-bar-right")
  const nextRound = reviewState.rounds.length + 1
  const captureBtn = el("button", "btn btn-primary btn-sm", `Capture round ${nextRound}`)
  captureBtn.addEventListener("click", async () => {
    captureBtn.disabled = true
    try {
      const res = await fetch("/api/rounds", {
        method: "POST",
        headers: { authorization: `Bearer ${reviewerToken()}` },
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        summaryEl.append(el("p", "error-note", `Capture failed (${res.status}): ${body.error ?? "unknown error"}`))
        captureBtn.disabled = false
        return
      }
      await refresh()
    } catch (err) {
      summaryEl.append(el("p", "error-note", `Capture failed: ${String(err)}`))
      captureBtn.disabled = false
    }
  })
  right.append(captureBtn)

  summaryEl.replaceChildren(
    el("span", "action-bar-state", "Stalled"),
    el("span", "action-bar-detail", "Session stopped responding — review stays usable"),
    right,
  )
  drawerEl.className = "action-drawer"
  drawerEl.replaceChildren()
}

function renderWorkingBar(summaryEl) {
  summaryEl.replaceChildren(
    el("span", "action-bar-state", "Agent working…"),
    el("span", "action-bar-detail", `session: ${reviewState.sessionID}`),
  )
}

function renderFixErrorBar(summaryEl, drawerEl, submission) {
  summaryEl.replaceChildren(
    el("span", "action-bar-state", "Fix failed"),
    el("span", "action-bar-detail", submission.statusError),
  )
  drawerEl.className = "action-drawer"
  drawerEl.replaceChildren()
}

function renderPlanItem(request, submission) {
  const item = el("div", "plan-item")
  const header = el("div", "plan-item-header")
  header.append(
    originTag(request.origin, request.comment?.author),
    el("span", "plan-item-text", request.text),
  )
  item.append(header)
  return item
}

// ── Submit ──

async function postSubmit(requests) {
  const res = await fetch("/api/submit", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${reviewerToken()}` },
    body: JSON.stringify({ requests }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    return `Submit failed (${res.status}): ${body.error ?? "unknown error"}`
  }
  return null
}

document.getElementById("submit-review").addEventListener("click", () => {
  if (submitInFlight || (reviewState?.submission ?? null) !== null) return
  void submitFromHeader()
})

async function submitFromHeader() {
  submitInFlight = true
  submitError = null
  const textarea = document.getElementById("submit-textarea")
  const requests = (textarea?.value ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
  render()
  let error = null
  try {
    error = await postSubmit(requests)
  } catch (err) {
    error = `Submit failed: ${String(err)}`
  }
  submitInFlight = false
  if (error !== null) {
    submitError = error
    render()
    return
  }
  drawerOpen = false
  await refresh()
}

// ── Helpers ──

function originTag(origin, commentAuthor) {
  if (origin === "accepted-finding") return el("span", "origin-tag accepted-finding", "finding")
  if (origin === "comment") return el("span", "origin-tag comment", `comment by ${commentAuthor ?? "unknown"}`)
  return el("span", "origin-tag user", origin)
}

function requestText(requestId) {
  const submission = reviewState.submission
  const request = submission?.payload.requests.find((r) => r.id === requestId)
  return request?.text ?? requestId
}

function queuedCommentCount(payload) {
  const covered = new Set(payload.requests.filter((request) => request.origin === "comment").map((request) => request.id))
  return reviewState.comments.filter((comment) => !covered.has(comment.id)).length
}

function renderCycleHistory() {
  const history = el("div", "plan-history")
  history.append(el("div", "drawer-section-title", "Plan and cycle history"))
  for (const cycle of reviewState.submissions ?? []) {
    for (const version of cycle.plans) {
      history.append(el("p", "action-bar-detail", `Round ${cycle.round} · cycle ${cycle.n} · plan v${version.n}: ${version.status}${cycle.approvedPlan === version.n ? " (approved)" : ""}`))
    }
  }
  return history
}

function reviewerToken() {
  return new URLSearchParams(window.location.search).get("reviewer") ?? ""
}

function renderCitations(list) {
  const wrap = el("div", "analysis-citations")
  for (const citation of list) {
    wrap.append(el("span", "citation", `“${citation.quote}” — ${citation.source}`))
  }
  return wrap
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

// ── SSE ──

function connectEvents() {
  const source = new EventSource("/api/events")
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
  source.addEventListener("answer", (event) => {
    const data = JSON.parse(event.data)
    if (qaLog.some((qa) => qa.id === data.id)) return
    qaLog.unshift({ id: data.id, question: data.question, answer: data.answer })
    render()
  })
}

function setBanner(visible) {
  document.getElementById("reconnect-banner").classList.toggle("hidden", !visible)
}

// ── Scroll spy ──

document.querySelector(".diff-pane")?.addEventListener("scroll", () => {
  updateFileNavActive()
})

// ── Event listeners ──

document.getElementById("round-select").addEventListener("change", (event) => {
  selectedRound = Number(event.target.value)
  expandedAnalysis.clear()
  render()
})

document.getElementById("overall-comment").addEventListener("click", () => {
  if (selectedRound === null) return
  beginComment("overall", { round: selectedRound })
})

// ── Boot ──

refresh()
connectEvents()
