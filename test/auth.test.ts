import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CONTROL_ROUTE_PATHS,
  generateReviewerToken,
  startReviewServer,
} from "../src/server/http.ts"

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