# Contributing to Forgium

This document is for people changing Forgium itself. For installation and
workflow usage, see [README.md](README.md).

## Development setup

```bash
npm install
npm run build
```

## Verification

Run the deterministic suite and static checks before committing:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

The real Pi smoke test is opt-in because it uses the model configured in Pi
and may consume tokens:

```bash
pi install npm:pi-spec-flow@0.4.8
npm run test:e2e:pi
```

The smoke test uses one minimal text-file ticket and verifies the complete
`ready → doing → review → done` lifecycle. It is not part of `npm test`.

## Project documentation

- [Documentation index](docs/README.md)
- [Architecture and lifecycle plan](docs/plans/0001-loop-implementation-plan.md)
- [Execution adapter contract](docs/adr/0005-execution-adapter-contract.md)
- [`pi-spec-flow` adapter decision](docs/adr/0006-pi-spec-flow-adapter.md)

ADRs are normative when they differ from the historical technical
specification.

## Release checklist

1. Update the version in `package.json`.
2. Run the deterministic checks above.
3. Run `npm pack --dry-run` and inspect the package contents.
4. Publish with npm using the required 2FA code:

   ```bash
   npm publish --access public --otp <code>
   ```

