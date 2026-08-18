# Pinned MCP SDK performance fork

These packages are built from
[`emrikol/typescript-sdk-mod-performance`](https://github.com/emrikol/typescript-sdk-mod-performance)
commit `b7608a8ebbd19c33089f2b616b80df7592c84fba`:

| Package                        | Version          | SHA-256                                                            |
| ------------------------------ | ---------------- | ------------------------------------------------------------------ |
| `@modelcontextprotocol/core`   | `2.0.0-mod-perf` | `fb665bac2c7a1114a2ef7eaaaabaaa57af3023a93ace823e7b2fb5cda2f90b3b` |
| `@modelcontextprotocol/node`   | `2.0.0-mod-perf` | `35876c6fffb1840b3b819684952de34bcc267f4e553b594d083da1621dff5337` |
| `@modelcontextprotocol/server` | `2.0.0-mod-perf` | `e4801adf15c4218418732c31f1788b7f3fc7bf9aacdff2bba2cf33c31f55a1a7` |

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
git checkout b7608a8ebbd19c33089f2b616b80df7592c84fba
pnpm install --frozen-lockfile

pnpm --dir packages/core pack --pack-destination /path/to/ecobee-mcp/vendor
pnpm --dir packages/server pack --pack-destination /path/to/ecobee-mcp/vendor
pnpm --dir packages/middleware/node pack --pack-destination /path/to/ecobee-mcp/vendor
```

Rename each generated tarball to include the source commit suffix `-b7608a8`
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
