# Plan 0005: Estrategia de pruebas para `forgium run`

**Estado:** Activo  
**Fecha:** 2026-07-12  
**Aplica a:** Fase 4 de [Plan 0001](0001-loop-implementation-plan.md) y
[ADR 0003](../adr/0003-forgium-run-contract.md)

## Objetivo

Verificar que `run` compone triage y selección de Features sin ampliar la
autonomía antes de tener un `ExecutionAdapter` definido. En esta fase un
preflight correcto puede identificar una Feature `ready`, pero debe detenerse
con `engine_unavailable` sin moverla a `doing`.

## Casos TDD

- **Rojo:** `--non-interactive` nunca aprueba Inbox `captured`.
- **Rojo:** el límite por defecto es una Feature y `--max-features` acepta solo
  enteros positivos.
- **Rojo:** `--until-empty` es incompatible con `--max-features`.
- **Rojo:** `--dry-run` no crea Drafts, no promueve Features ni crea leases.
- **Rojo:** un preflight inválido detiene el run sin mutar el repositorio.
- **Rojo:** sin motor configurado, una Feature `ready` permanece `ready` y el
  resultado explica `engine_unavailable`.
- **Rojo:** `--json` devuelve `root`, acciones, Features afectadas y
  `stopReason`.

## Verificación

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

