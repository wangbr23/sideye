import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { $ } from "bun"
import {
  CONTROL_ROUTE_PATHS,
  generateReviewerToken,
  startReviewServer,
} from "../src/server/http.ts"
import { buildHandlers } from "../src/server/routes.ts"
import { createState, captureRound } from "../src/server/state.ts"

let staticDir: string
const token = generateReviewerToken()

beforeEach(() => {
  staticDir = mkdtempSync(join(tmpdir(), "sideye-static-"))
  writeFileSync(join(staticDir, "index.html"), "<html>sideye</html>")
  writeFileSync(join(staticDir, "app.js"), "// app")
  writeFileSync(join(staticDir, "style.css"), "body {}")
})

afterEach(() => {
  rmSync(staticDir, { recursive: true, force: true })
})

function startServer() {
  return startReviewServer({ repoPath: "/repo", token, staticDir, handlers: {} })
}

function port(server: { port: number }) {
  return `http://127.0.0.1:${server.port}`
}

describe("review server skeleton", () => {
  test("binds an ephemeral loopback port and answers health without a token", async () => {
    const server = startServer()
    try {
      expect(server.port).toBeGreaterThan(0)
      const res = await fetch(`${port(server)}/api/health`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ status: "ok", repoPath: "/repo" })
    } finally {
      server.stop()
    }
  })

  test("serves the three static frontend files and 404s others", async () => {
    const server = startServer()
    try {
      const base = port(server)
      expect((await fetch(`${base}/`)).status).toBe(200)
      expect(await (await fetch(`${base}/`)).text()).toContain("sideye")
      expect((await fetch(`${base}/app.js`)).status).toBe(200)
      expect((await fetch(`${base}/style.css`)).status).toBe(200)
      expect((await fetch(`${base}/../etc/passwd`)).status).toBe(404)
      expect((await fetch(`${base}/nope.js`)).status).toBe(404)
    } finally {
      server.stop()
    }
  })

  test("control routes reject requests without the reviewer token", async () => {
    const server = startServer()
    try {
      for (const path of CONTROL_ROUTE_PATHS) {
        const res = await fetch(`${port(server)}${path}`, { method: "POST" })
        expect(res.status).toBe(401)
      }
    } finally {
      server.stop()
    }
  })

  test("control routes with the token pass the guard (404 until handlers land)", async () => {
    const server = startServer()
    try {
      for (const path of CONTROL_ROUTE_PATHS) {
        const res = await fetch(`${port(server)}${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        })
        expect(res.status).toBe(404)
      }
    } finally {
      server.stop()
    }
  })

  test("wrong or malformed bearer tokens are rejected", async () => {
    const server = startServer()
    try {
      const base = port(server)
      const wrong = await fetch(`${base}/api/submit`, {
        method: "POST",
        headers: { authorization: `Bearer not-the-token` },
      })
      expect(wrong.status).toBe(401)
      const malformed = await fetch(`${base}/api/submit`, {
        method: "POST",
        headers: { authorization: token },
      })
      expect(malformed.status).toBe(401)
    } finally {
      server.stop()
    }
  })
})

describe("open-tier comment route", () => {
  let repoDir: string
  let state: ReturnType<typeof createState>

  beforeEach(async () => {
    repoDir = mkdtempSync(join(tmpdir(), "sideye-auth-comments-"))
    await $`git init`.cwd(repoDir).quiet()
    await $`git config user.email test@sideye.local`.cwd(repoDir).quiet()
    await $`git config user.name Sideye Test`.cwd(repoDir).quiet()
    writeFileSync(join(repoDir, "a.txt"), "one\n")
    await $`git add a.txt`.cwd(repoDir).quiet()
    await $`git commit -m base`.cwd(repoDir).quiet()
    writeFileSync(join(repoDir, "a.txt"), "one\ntwo\nthree\n")
    state = createState({
      token: generateReviewerToken(),
      sessionID: "ses_1",
      repoPath: repoDir,
      target: { kind: "worktree" },
    })
    await captureRound(state)
  })

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true })
  })

  function startStateServer() {
    return startReviewServer({
      repoPath: repoDir,
      token: generateReviewerToken(),
      staticDir: mkdtempSync(join(tmpdir(), "sideye-auth-static-")),
      handlers: buildHandlers(state),
    })
  }

  test("posts a comment without a token and it appears in /api/state", async () => {
    const server = startStateServer()
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          author: "second-opinion-agent",
          scope: "inline",
          anchor: { round: 1, file: "a.txt", hunkIndex: 0, lineRange: [2, 3] },
          body: "consider a guard clause",
        }),
      })
      expect(res.status).toBe(200)
      const comment = (await res.json()) as { id: string; author: string }
      expect(comment.author).toBe("second-opinion-agent")
      expect(comment.id).toBeTruthy()

      const stateRes = await fetch(`http://127.0.0.1:${server.port}/api/state`)
      const body = (await stateRes.json()) as { comments: { id: string }[] }
      expect(body.comments.map((c) => c.id)).toEqual([comment.id])
    } finally {
      server.stop()
    }
  })

  test("missing author is rejected with 400", async () => {
    const server = startStateServer()
    try {
      const base = `http://127.0.0.1:${server.port}/api/comments`
      const noAuthor = await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: "overall",
          anchor: { round: 1 },
          body: "no attribution",
        }),
      })
      expect(noAuthor.status).toBe(400)
      const blankAuthor = await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ author: "  ", scope: "overall", anchor: { round: 1 }, body: "x" }),
      })
      expect(blankAuthor.status).toBe(400)
      const badJson = await fetch(base, { method: "POST", body: "not json" })
      expect(badJson.status).toBe(400)
    } finally {
      server.stop()
    }
  })

  test("invalid anchor is rejected with 400 and stores nothing", async () => {
    const server = startStateServer()
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          author: "agent",
          scope: "inline",
          anchor: { round: 1, file: "a.txt", hunkIndex: 9 },
          body: "bad hunk",
        }),
      })
      expect(res.status).toBe(400)
      const errBody = (await res.json()) as { error: string }
      expect(errBody.error).toMatch(/anchor\.hunkIndex/)
      expect(state.comments).toHaveLength(0)
    } finally {
      server.stop()
    }
  })
})