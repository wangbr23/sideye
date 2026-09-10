// Read-only diff frontend (LLD §8). No framework, no bundler: plain DOM built
// with textContent only — diff content, paths, and comments are untrusted data.
// Comments/analysis UI arrive in later tasks; this shell owns the diff pane,
// the round selector, and the SSE subscribe → reconnect refetch loop.

const SSE_EVENTS = ["analysis.update", "answer", "plan.ready", "status.ready", "round.prompt"]
const BANNER_AFTER_FAILURES = 3

let reviewState = null // latest /api/state projection
let selectedRound = null // null → latest round
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

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

document.getElementById("round-select").addEventListener("change", (event) => {
  selectedRound = Number(event.target.value)
  renderDiff()
})

refresh()
connectEvents()