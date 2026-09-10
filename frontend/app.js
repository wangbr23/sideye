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
  section.append(header)

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
    hunkObserver.observe(box)
  }
  return section
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
    row.append(
      el("span", "ln", line.origin === "+" ? "" : String(oldLine)),
      el("span", "ln", line.origin === "-" ? "" : String(newLine)),
      el("span", "origin", line.origin),
      el("span", "content", line.content),
    )
    box.append(row)
    if (line.origin !== "+") oldLine++
    if (line.origin !== "-") newLine++
  }
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
      return el("p", "empty", "No comments yet.")
    case "Status":
      return el("p", "empty", "No submission yet.")
    default:
      return el("p", "empty", "Nothing here.")
  }
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