# Plan 0006: Estrategia de pruebas para adapters de ejecución

**Estado:** Completado
**Fecha:** 2026-07-12  
**Actualizado:** 2026-07-13
**Aplica a:** Fase 5 de [Plan 0001](0001-loop-implementation-plan.md) y
[ADR 0005](../adr/0005-execution-adapter-contract.md)

## Casos TDD

- **Rojo:** el registry resuelve un adapter compatible y rechaza uno ausente.
- **Rojo:** `completed` crea execution receipt, verifica y deja la Feature en
  `review`, nunca en `done`.
- **Rojo:** `blocked` crea execution/handoff receipts y mueve a `blocked`.
- **Rojo:** `cancelled` conserva la Feature en `doing`.
- **Rojo:** no hay transición a `doing` si no existe un adapter disponible.
- `PiRpcExecutionAdapter` consume el stream RPC documentado y falla cerrado si
  no recibe el marcador estructurado.
- `SpecFlowExecutionAdapter` responde la confirmación de Pi, exige el resultado
  read-only `spec_flow_status` y rechaza tickets incompletos o checkpoints con
  review pendiente.
- Al mover una Feature `ready → doing`, el perfil usado por el adapter se
  resuelve de nuevo para no conservar rutas de artefactos obsoletas.

La validación real de `pi-spec-flow` queda documentada en Plan 0007 porque
requiere un modelo configurado en Pi.

## Verificación

```bash
npm test
npm run typecheck
npm run build
git diff --check
```
