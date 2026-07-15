# ADR 0007: Loop de implementación por observación de `pi-spec-flow`

**Estado:** Aceptado localmente  
**Fecha:** 2026-07-13

## Decisión

El loop de producto termina cuando una Work llega a `ready`. La implementación
es un loop separado invocado mediante `forgium implement`.

Forgium puede iniciar `pi-spec-flow`, pero no controla ni interpreta su flujo
interno de tickets, checkpoints o code review. Después de cada invocación,
consulta `spec_flow_status`, persiste el snapshot en el receipt de ejecución y
notifica el estado observado.

| Estado `spec_flow_status` | Estado Forgium | Acción |
| --- | --- | --- |
| tickets pendientes/en progreso o checkpoint review pendiente | `doing` | Receipt `needs_human`; avisar a la persona. |
| `complete: true` | `review` | Ejecutar verificación de Forgium y solicitar review externo. |
| bloqueo explícito | `blocked` | Persistir handoff y avisar. |
| payload inválido/ausente | `doing` | Fallar cerrado con receipt `needs_human`. |

La salida limpia de Pi no es evidencia de finalización. Solo el snapshot
estructurado con `complete: true` permite salir de `doing`.

## Consecuencias

- Un code review de `pi-spec-flow` no se convierte en bloqueo de Forgium ni se
  auto-resume.
- Una nueva ejecución de `forgium implement` vuelve a observar el estado
  durable de los tickets.
- Los receipts incluyen el snapshot estructurado para que la persona pueda
  decidir el siguiente paso sin depender de transcripciones.
