# Plan 0006: Estrategia de pruebas para adapters de ejecución

**Estado:** Activo  
**Fecha:** 2026-07-12  
**Aplica a:** Fase 5 de [Plan 0001](0001-loop-implementation-plan.md) y
[ADR 0005](../adr/0005-execution-adapter-contract.md)

## Casos TDD

- **Rojo:** el registry resuelve un adapter compatible y rechaza uno ausente.
- **Rojo:** `completed` crea execution receipt, verifica y deja la Feature en
  `review`, nunca en `done`.
- **Rojo:** `blocked` crea execution/handoff receipts y mueve a `blocked`.
- **Rojo:** `cancelled` conserva la Feature en `doing`.
- **Rojo:** no hay transición a `doing` si no existe un adapter disponible.

## Verificación

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

