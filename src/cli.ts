// `sideye review [commit]` launcher lands in T8.
export async function main() {
  throw new Error("sideye CLI not implemented yet (T8)")
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}