# Plan 0009: Implementación observada mediante `pi-spec-flow`

**Estado:** En curso  
**Fecha:** 2026-07-14

## Objetivo

Mantener separado el loop de producto del loop de implementación. El primero
deja Work `ready`; el segundo inicia o reanuda `pi-spec-flow`, observa su estado
estructurado y avisa a la persona sin tomar control de tickets o checkpoints.

## Alcance inicial

1. `forgium implement [id] --engine pi-spec-flow` selecciona una Work `ready`
   o `doing` y delega una iteración a Pi.
2. El adapter consulta `spec_flow_status` después de estabilizarse.
3. El snapshot se guarda en el receipt `execution.details.specFlow`.
4. Tickets pendientes, issues o code review pendiente producen `needs_human`:
   la Work queda en `doing` con handoff y el CLI informa el motivo.
5. Solo `complete: true` permite verificación y transición a `review`.
6. Un E2E con CLI compilada y Pi RPC falso cubre estado pendiente → completo.
7. Toda Work debe declarar un comando de verificación o evidencia manual
   requerida antes de llegar a `ready`.
8. `forgium review` es una decisión humana explícita; identidad independiente
   queda fuera del alcance de v1.
9. `forgium status --verbose` muestra el último snapshot observado y la
   siguiente acción para Work `doing` o `review`.

## Fuera de alcance

- Reanudar o cerrar tickets de `pi-spec-flow` automáticamente.
- Interpretar texto libre de Pi como fuente de verdad.
- Aprobar la Work o moverla a `done`.
- Política de identidad independiente para review.
