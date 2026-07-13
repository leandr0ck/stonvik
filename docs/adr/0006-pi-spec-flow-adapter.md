# ADR 0006: Adaptador `pi-spec-flow` mediante RPC

**Estado:** Aceptado  
**Fecha:** 2026-07-13  
**Decisores:** Forgium maintainers

## Contexto

`pi-spec-flow` es una extensión de Pi que mantiene la autoridad sobre tickets,
checkpoints, handoffs y el orden de implementación. Forgium debe delegar ese
flujo sin duplicar su parser de tickets ni interpretar salida humana.

La extensión expone el comando `/spec-flow-implement` y una inspección
estructurada `spec_flow_status`. No se añade `pi-spec-flow` como dependencia de
producción de Forgium: la integración ocurre a través del protocolo RPC
documentado de Pi.

## Decisión

Forgium añade un `SpecFlowExecutionAdapter` opt-in mediante:

```text
forgium run --engine pi-spec-flow
```

El adapter:

- solo acepta perfiles `spec-flow`;
- ejecuta `/spec-flow-implement <specPath>` dentro de la raíz del repositorio;
- responde `Yes, proceed` a la confirmación del ticket seleccionado, porque la
  Feature ya superó el gate de Forgium;
- espera que Pi se estabilice y solicita una consulta read-only a
  `spec_flow_status`;
- considera completada la ejecución únicamente cuando `complete: true`;
- convierte tickets pendientes, issues o reviews de checkpoint en
  `needs_human`;
- falla cerrado si no recibe un resultado estructurado;
- respeta timeout y cancelación RPC.

El adapter requiere `pi-spec-flow >= 0.4.8`. Esa versión actualiza el planning
context cuando el comando recibe un `spec.md` cuya carpeta fue movida por el
ciclo de vida de Forgium (`ready → doing`); sin esa actualización, las tools
de cierre podrían resolver el ticket store anterior.

Forgium no marca tickets ni crea handoffs. El adapter tampoco aprueba la
Feature: `executeFeature` conserva la transición a `review` y los receipts.

## Consecuencias

- `pi-spec-flow` sigue siendo dueño del estado de tickets y checkpoints.
- La ejecución spec-driven puede detenerse de forma segura en un gate humano.
- `--engine pi` continúa reservado para Features `direct`.
- La disponibilidad del binario Pi no garantiza que la extensión esté cargada;
  si la consulta estructurada no aparece, el resultado es `needs_human`.
- La integración se validó con un smoke test real opt-in que completa un ticket
  mínimo y requiere review explícito antes de `done`.
