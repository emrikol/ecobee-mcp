# Pinned MCP SDK performance fork

These packages are built from
[`emrikol/typescript-sdk-mod-performance`](https://github.com/emrikol/typescript-sdk-mod-performance)
commit `346fdcc5e6be5c2b2a92b9043dc1d7ec41d570f9`:

| Package                        | Version          | SHA-256                                                            |
| ------------------------------ | ---------------- | ------------------------------------------------------------------ |
| `@modelcontextprotocol/core`   | `2.0.0-mod-perf` | `f3f5066ce5dbf2e1b58a55abd3a5a447b276a8f5d3b0355bab89c49ed5a9c6a8` |
| `@modelcontextprotocol/node`   | `2.0.0-mod-perf` | `d602f1991c3461eb9cb0000be245d8c8de0813d04a931d8ec9afd7dc098f9372` |
| `@modelcontextprotocol/server` | `2.0.0-mod-perf` | `760b93a44f84a92c2d5227781392191b89cb399c9c92a2c98237be3c4f81b6bb` |

The fork is an npm workspace, so npm cannot install its individual packages
directly from the repository URL. Committed `file:` tarballs make the exact
reviewed artifacts installable on the Raspberry Pi without installing pnpm or
an SDK build toolchain there. `package-lock.json` records npm integrity hashes,
and `test/sdk-package-provenance.test.ts` pins their SHA-256 values.

## Rebuild

Use Node 20 or newer and pnpm 10.26.1:

```bash
git clone git@github.com:emrikol/typescript-sdk-mod-performance.git
cd typescript-sdk-mod-performance
git checkout 346fdcc5e6be5c2b2a92b9043dc1d7ec41d570f9
pnpm install --frozen-lockfile

pnpm --dir packages/core pack --pack-destination /path/to/ecobee-mcp/vendor
pnpm --dir packages/server pack --pack-destination /path/to/ecobee-mcp/vendor
pnpm --dir packages/middleware/node pack --pack-destination /path/to/ecobee-mcp/vendor
```

Rename each generated tarball to include the source commit suffix `-346fdcc`
before updating `package.json`. The suffix makes a source change produce a new
file dependency instead of allowing npm to reuse metadata cached for the old
path.

`pnpm pack` does not promise byte-reproducible archive metadata or JSON key
ordering, so a clean rebuild may have a different tarball hash even when its
runtime files are unchanged. Compare the extracted package contents, review
any differences, then update this file and the provenance test deliberately.
Do not accept an unreviewed tarball with a changed hash. The SDK's upstream
license and transition notice are preserved in
[MCP-SDK-LICENSE](MCP-SDK-LICENSE).
