import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { parseStructuredOutput, replyText } from "../src/server/structured.ts"

const schema = z.object({ answer: z.number() })

describe("parseStructuredOutput", () => {
  test("a valid structured payload wins without touching the text", () => {
    const parsed = parseStructuredOutput(
      { structured: { answer: 1 }, text: '{"answer": 2}' },
      schema,
    )
    expect(parsed).toEqual({ data: { answer: 1 } })
  })

  test("mimicked-as-text JSON is recovered when the structured channel failed", () => {
    // the 1.18.31 failure mode: StructuredOutputError, model wrote the call as
    // text inside markdown fences / improvised markers
    const parsed = parseStructuredOutput(
      {
        error: { name: "StructuredOutputError", message: "Model did not produce structured output" },
        text: 'Sure — here is the report:\n```json\n{"answer": 7}\n```',
      },
      schema,
    )
    expect(parsed).toEqual({ data: { answer: 7 } })
  })

  test("invalid structured output reports zod issues, then still scans the text", () => {
    const parsed = parseStructuredOutput(
      { structured: { answer: "not a number" }, text: '{"answer": 3}' },
      schema,
    )
    expect(parsed).toEqual({ data: { answer: 3 } })
  })

  test("unparseable attempts fold into one issues string", () => {
    const parsed = parseStructuredOutput(
      {
        structured: { answer: "nope" },
        error: undefined,
        text: "no json here at all",
      },
      schema,
    )
    if ("data" in parsed) throw new Error("expected issues, got data")
    expect(parsed.issues).toContain("structured output:")
  })

  test("no structured, no error, no JSON says exactly that", () => {
    const parsed = parseStructuredOutput({ text: "just prose" }, schema)
    if ("data" in parsed) throw new Error("expected issues, got data")
    expect(parsed.issues).toBe("no structured output and no JSON in the reply text")
  })

  test("braces inside string literals cannot desync the region scan", () => {
    const parsed = parseStructuredOutput(
      { text: 'prefix {"answer": 5, "note": "curly } brace"} suffix' },
      schema,
    )
    expect(parsed).toEqual({ data: { answer: 5 } })
  })

  test("empty text yields the no-output issue", () => {
    const parsed = parseStructuredOutput({}, schema)
    if ("data" in parsed) throw new Error("expected issues, got data")
    expect(parsed.issues).toBe("no structured output and no JSON in the reply text")
  })
})

describe("replyText", () => {
  test("joins text parts and ignores other part types", () => {
    const parts = [
      { id: "p1", sessionID: "s", messageID: "m", type: "text" as const, text: "line one" },
      { id: "p2", sessionID: "s", messageID: "m", type: "reasoning" as const, text: "thinking", time: { start: 0 } },
      { id: "p3", sessionID: "s", messageID: "m", type: "text" as const, text: "line two" },
    ]
    expect(replyText(parts as never)).toBe("line one\nline two")
  })

  test("undefined parts yield an empty string", () => {
    expect(replyText(undefined)).toBe("")
  })
})
