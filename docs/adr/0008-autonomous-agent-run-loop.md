# ADR 0008: `forgium run` como loop autónomo de agentes

**Estado:** Aceptado localmente  
**Fecha:** 2026-07-14

## Decisión

`forgium run` sustituye el contrato de producto-only de ADR 0007 como la
interfaz principal. Orquesta, en orden, clasificación de Inbox, definición
humana cuando corresponde, implementación, verificación y review independiente
hasta que la cola quede sin trabajo elegible o aparezca una gate/bloqueo.

Los comandos `triage`, `work`, `implement`, `review` y `status` permanecen
como APIs de recuperación, automatización y diagnóstico; no son el recorrido
normal de una persona usuaria.

El loop mantiene estos límites:

- Pi puede clasificar automáticamente únicamente trabajo XS/S de bajo riesgo;
  el resto requiere una decisión humana o una definición humana.
- Una definición Spec/ADR pertenece a una carpeta de definición de la futura
  Work y no es una Work ejecutable.
- `pi-spec-flow` conserva la propiedad de tickets y revisiones de ticket.
  Forgium añade una revisión de Work independiente; una sesión implementadora
  no puede aprobar su propia Work.
- Un checkpoint, una revisión pendiente, una respuesta no estructurada de Pi,
  una verificación fallida o un bloqueo no se reintenta en bucle. `run` deja
  evidencia durable, muestra la acción siguiente y se detiene. `--watch` queda
  esperando cambios durables antes de intentar una nueva iteración.

## Consecuencias

- ADR 0003 se reemplaza para la interfaz de `run`.
- ADR 0007 sigue definiendo la observación segura de `pi-spec-flow`, pero deja
  de requerir que la persona invoque `forgium implement` manualmente.
- Se introducen un clasificador Pi, un adaptador Pi de implementación directa,
  un adaptador de review independiente y una API de eventos para `run --watch`.

La especificación ejecutable y los criterios de aceptación están en
[Plan 0010](../plans/0010-autonomous-agent-loop-objective.md).
