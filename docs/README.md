# Forgium technical documentation

## Architecture decision records

- [ADR 0001 — Arquitectura de loops](adr/0001-loop-architecture.md)
- [ADR 0002 — Drafts y artefactos del ciclo de vida](adr/0002-draft-state-and-artifacts.md)
- [ADR 0003 — Contrato de `forgium run`](adr/0003-forgium-run-contract.md)
- [ADR 0004 — Verificación, review y receipts](adr/0004-verification-review-and-receipts.md)
- [ADR 0005 — Contrato de `ExecutionAdapter`](adr/0005-execution-adapter-contract.md)
- [ADR 0006 — Adaptador `pi-spec-flow` mediante RPC](adr/0006-pi-spec-flow-adapter.md)
- [ADR 0007 — Loop de implementación por observación](adr/0007-implementation-observation-loop.md)
- [ADR 0008 — `forgium run` como loop autónomo de agentes](adr/0008-autonomous-agent-run-loop.md)

## Planes

- [Plan 0001 — Implementación del loop](plans/0001-loop-implementation-plan.md)
- [Plan 0002 — Estrategia de pruebas para Drafts](plans/0002-test-strategy.md)
- [Plan 0003 — Estrategia de pruebas para triage](plans/0003-test-strategy.md)
- [Plan 0004 — Estrategia de pruebas para receipts y review](plans/0004-test-strategy.md)
- [Plan 0005 — Estrategia de pruebas para `forgium run`](plans/0005-test-strategy.md)
- [Plan 0006 — Estrategia de pruebas para adapters de ejecución](plans/0006-test-strategy.md)
- [Plan 0007 — Estrategia de pruebas end-to-end y endurecimiento](plans/0007-test-strategy.md)
- [Plan 0009 — Implementación observada mediante `pi-spec-flow`](plans/0009-implementation-observation-plan.md)
- [Objetivo 0010 — Loop autónomo de agentes](plans/0010-autonomous-agent-loop-objective.md)

The ADRs are normative for decisions made after the initial technical
specification. When an ADR and `loop-technical-spec.md` disagree, the ADR wins.

## Estado de implementación

**Actualizado:** 2026-07-13
**Estado:** el loop autónomo está implementado; las fases históricas de Draft
se conservan solo como registro y no forman parte del árbol ejecutable.

- Inbox, definición humana, clasificación, receipts, verificación, review,
  selección secuencial y `forgium run --watch` están cubiertos por pruebas
  deterministas.
- Los adapters opt-in `pi` y `pi-spec-flow` están disponibles desde
  `forgium run --engine <engine>`.
- La integración spec-driven requiere `pi-spec-flow >= 0.4.8` y fue validada
  con Pi real: ticket cerrado, estado estructurado completo, receipts y
  transición `ready → doing → review → done`.
- El smoke test real es opt-in porque usa el modelo configurado en Pi:
  `npm run test:e2e:pi`.

Consulta los planes de prueba para la cobertura detallada y los ADR para los
contratos normativos.
