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
- [ADR 0009 — Procedencia de Inbox junto a Work](adr/0009-inbox-provenance-with-work.md)

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
- [Auditoría 0011 — Trazabilidad del contrato autónomo y pruebas](plans/0011-autonomous-run-contract-test-audit.md)
- [Plan 0012 — Feedback de ejecución y eventos para `forgium run`](plans/0012-run-event-feedback-plan.md)

The ADRs are normative for decisions made after the initial technical
specification. When an ADR and `loop-technical-spec.md` disagree, the ADR wins.

## Estado de implementación

**Actualizado:** 2026-07-14
**Estado:** el loop autónomo está implementado; las fases históricas de Draft
se conservan solo como registro y no forman parte del árbol ejecutable. La
cobertura del contrato se audita explícitamente en el Plan 0011; una prueba
verde no implica que el recorrido autónomo completo esté cubierto.

- Hay pruebas deterministas para partes del Inbox, definición humana,
  ejecución, verificación y review. La clasificación inválida tiene una
  regresión de CLI y el contrato autónomo offline se ejerce mediante la CLI
  compilada con un Pi RPC falso.
- Los adapters `pi` y `pi-spec-flow` se seleccionan automáticamente según el
  perfil de la Work; `forgium run` sigue siendo la interfaz principal.
- La integración spec-driven requiere `pi-spec-flow >= 0.4.8` y fue validada
  con Pi real: ticket cerrado, estado estructurado completo, receipts y gate
  de review independiente; sólo llega a `done` si esa segunda sesión devuelve
  una decisión estructurada aprobada.
- El gate de contrato usa la CLI compilada y un proceso Pi real en RPC, con un
  proveedor fixture local determinista: `npm run test:e2e:real`. El canario
  opt-in contra el modelo y `pi-spec-flow` configurados es
  `npm run test:e2e:live`.
- Las definiciones humanas se editan mediante `forgium definition edit
  <inbox-id>` usando `VISUAL` o `EDITOR`, y sólo `run` puede confirmarlas y
  promoverlas a Work.

## Gates de calidad

```bash
npm test                    # build + unitarias/integración + E2E offline
npm run typecheck
npm run build
git diff --check
npm run test:e2e:real       # release gate: CLI + proceso Pi RPC + fixture
npm run test:e2e:live       # canario opt-in: modelo y pi-spec-flow reales
npm run test:release        # todos los gates de release
```

CI ejecuta los cuatro primeros checks en cada cambio. El job real se habilita
con la variable de repositorio `FORGIUM_RUN_REAL_E2E=1` en un environment que
tenga Pi y `pi-spec-flow` configurados.

Consulta los planes de prueba para la cobertura detallada y los ADR para los
contratos normativos.
