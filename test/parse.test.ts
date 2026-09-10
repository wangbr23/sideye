import { describe, expect, test } from "bun:test"
import { parseDiff } from "../src/git/parse.ts"

const MODIFIED = `diff --git a/a.txt b/a.txt
index 1111111..2222222 100644
--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,3 @@
 one
-old
+new
+extra
@@ -10,2 +10,2 @@
-x
+y
 tail
`

const NUMSTAT_MODIFIED = "2\t1\ta.txt\n"

describe("parseDiff", () => {
  test("modified file: hunks, counts, and line origins", () => {
    const files = parseDiff(MODIFIED, NUMSTAT_MODIFIED)
    expect(files).toHaveLength(1)
    const file = files[0]
    expect(file?.path).toBe("a.txt")
    expect(file?.status).toBe("modified")
    expect(file?.binary).toBe(false)
    expect(file?.hunks).toHaveLength(2)

    const first = file?.hunks[0]
    expect(first?.index).toBe(0)
    expect(first?.header).toBe("@@ -1,2 +1,3 @@")
    expect(first?.oldStart).toBe(1)
    expect(first?.oldLines).toBe(2)
    expect(first?.newStart).toBe(1)
    expect(first?.newLines).toBe(3)
    expect(first?.lines).toEqual([
      { origin: " ", content: "one" },
      { origin: "-", content: "old" },
      { origin: "+", content: "new" },
      { origin: "+", content: "extra" },
    ])

    const second = file?.hunks[1]
    expect(second?.index).toBe(1)
    expect(second?.newStart).toBe(10)
  })

  test("new file: added status, /dev/null old side", () => {
    const diff = `diff --git a/added.txt b/added.txt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/added.txt
@@ -0,0 +1,1 @@
+hello
`
    const files = parseDiff(diff, "1\t0\tadded.txt\n")
    expect(files[0]?.status).toBe("added")
    expect(files[0]?.path).toBe("added.txt")
    expect(files[0]?.hunks[0]?.lines).toEqual([{ origin: "+", content: "hello" }])
  })

  test("deleted file: deleted status, empty hunks not required", () => {
    const diff = `diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 4444444..0000000
--- a/gone.txt
+++ /dev/null
@@ -1,1 +0,0 @@
-bye
`
    const files = parseDiff(diff, "0\t1\tgone.txt\n")
    expect(files[0]?.status).toBe("deleted")
    expect(files[0]?.path).toBe("gone.txt")
    expect(files[0]?.hunks[0]?.lines).toEqual([{ origin: "-", content: "bye" }])
  })

  test("rename: status renamed, path is the new name", () => {
    const diff = `diff --git a/old.txt b/renamed.txt
similarity index 100%
rename from old.txt
rename to renamed.txt
`
    const files = parseDiff(diff, "0\t0\told.txt => renamed.txt\n")
    expect(files[0]?.status).toBe("renamed")
    expect(files[0]?.path).toBe("renamed.txt")
    expect(files[0]?.hunks).toEqual([])
  })

  test("binary via numstat `-` row: binary true", () => {
    const diff = `diff --git a/bin.dat b/bin.dat
index 5555555..6666666 100644
Binary files a/bin.dat and b/bin.dat differ
`
    const files = parseDiff(diff, "-\t-\tbin.dat\n")
    expect(files[0]?.binary).toBe(true)
    expect(files[0]?.hunks).toEqual([])
  })

  test("binary via brace-form numstat rename path", () => {
    const diff = `diff --git a/dir/old.dat b/dir/new.dat
similarity index 100%
rename from dir/old.dat
rename to dir/new.dat
Binary files a/dir/old.dat and b/dir/new.dat differ
`
    const files = parseDiff(diff, "-\t-\tdir/{old.dat => new.dat}\n")
    expect(files[0]?.path).toBe("dir/new.dat")
    expect(files[0]?.binary).toBe(true)
  })

  test("hunk without trailing context keeps final +/- lines", () => {
    const diff = `diff --git a/tail.txt b/tail.txt
index 7777777..8888888 100644
--- a/tail.txt
+++ b/tail.txt
@@ -1,1 +1,2 @@
 start
+finish
`
    const files = parseDiff(diff, "1\t0\ttail.txt\n")
    expect(files[0]?.hunks[0]?.lines).toEqual([
      { origin: " ", content: "start" },
      { origin: "+", content: "finish" },
    ])
  })

  test("CRLF diff: trailing \\r stripped from content, header intact", () => {
    const diff =
      "diff --git a/win.txt b/win.txt\r\n" +
      "index 8888888..9999999 100644\r\n" +
      "--- a/win.txt\r\n" +
      "+++ b/win.txt\r\n" +
      "@@ -1,1 +1,1 @@\r\n" +
      "-old line\r\n" +
      "+new line\r\n"
    const files = parseDiff(diff, "1\t1\twin.txt\n")
    expect(files[0]?.hunks[0]?.lines).toEqual([
      { origin: "-", content: "old line" },
      { origin: "+", content: "new line" },
    ])
  })

  test("hunk header without explicit counts defaults to 1", () => {
    const diff = `diff --git a/single.txt b/single.txt
index 9999999..aaaaaaa 100644
--- a/single.txt
+++ b/single.txt
@@ -3 +3 @@
-only
+only
`
    const files = parseDiff(diff, "0\t0\tsingle.txt\n")
    const hunk = files[0]?.hunks[0]
    expect(hunk?.oldStart).toBe(3)
    expect(hunk?.oldLines).toBe(1)
    expect(hunk?.newStart).toBe(3)
    expect(hunk?.newLines).toBe(1)
  })

  test("no newline at end of file marker is skipped", () => {
    const diff = `diff --git a/nonl.txt b/nonl.txt
index bbbbbbbb..cccccccc 100644
--- a/nonl.txt
+++ b/nonl.txt
@@ -1 +1 @@
-old\\ No newline at end of file
+new
\\ No newline at end of file
`
    const files = parseDiff(diff, "1\t1\tnonl.txt\n")
    expect(files[0]?.hunks[0]?.lines).toEqual([
      { origin: "-", content: "old\\ No newline at end of file" },
      { origin: "+", content: "new" },
    ])
  })

  test("multiple files parse independently", () => {
    const diff = `diff --git a/one.txt b/one.txt
index d1d1d1d..d2d2d2d 100644
--- a/one.txt
+++ b/one.txt
@@ -1 +1 @@
-a
+b
diff --git a/two.txt b/two.txt
deleted file mode 100644
index e1e1e1e..0000000
--- a/two.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
`
    const files = parseDiff(diff, "1\t1\tone.txt\n0\t1\ttwo.txt\n")
    expect(files).toHaveLength(2)
    expect(files[0]?.status).toBe("modified")
    expect(files[1]?.status).toBe("deleted")
  })

  test("empty diff yields no files", () => {
    expect(parseDiff("", "")).toEqual([])
  })
})