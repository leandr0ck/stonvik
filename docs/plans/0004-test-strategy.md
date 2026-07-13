# Plan 0004: Estrategia de pruebas para receipts y review

**Estado:** Activo  
**Fecha:** 2026-07-12  
**Aplica a:** Fase 3 de [Plan 0001](0001-loop-implementation-plan.md) y
[ADR 0004](../adr/0004-verification-review-and-receipts.md)

## Objetivo

Comprobar que las verificaciones y las decisiones de review dejan evidencia
durable, que los checks tienen límites y que ninguna Feature llega a `done`
sin un receipt de review aprobado.

## Casos TDD

- **Rojo:** un check exitoso genera receipt de verificación y mueve `doing` a
  `review`.
- **Rojo:** un check fallido genera receipt de verificación y handoff, pero la
  Feature permanece en `doing`.
- **Rojo:** `review` aprobado genera receipt y permite `review → done`.
- **Rojo:** `changes_requested` vuelve a `doing`; `blocked` mueve a `blocked`.
- **Rojo:** `doing → done` o `review → done` sin aprobación registrada se
  rechaza.
- **Rojo:** receipts inválidos, duplicados o con referencias locales rotas
  aparecen en `validate` y no se persisten.

## Verificación

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

