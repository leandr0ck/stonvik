# ADR 0005: Contrato de `ExecutionAdapter`

**Estado:** Aceptado  
**Fecha:** 2026-07-12  
**Decisores:** Forgium maintainers

## Contexto

`forgium run` debe conservar las reglas de estado, límites y receipts sin
conocer los detalles de Pi o `pi-spec-flow`. La Fase 5 necesita una frontera
estable para descubrir un motor, ejecutar una Feature y traducir su resultado.

Las APIs públicas y el formato instalados de Pi/`pi-spec-flow` aún no están
fijados en este repositorio. Integrarlos por comandos o nombres inferidos
crearía una dependencia frágil y violaría la separación de responsabilidades.

## Decisión

Forgium define un `ExecutionAdapter` pequeño y asíncrono. El adapter declara si
puede manejar un `ExecutionProfile`, informa disponibilidad y devuelve un
resultado tipado. Forgium conserva la autoridad sobre transiciones, receipts,
verificación y review.

```text
ready
  → resolver adapter
  → adapter disponible
  → doing + lease
  → adapter.execute()
  → execution receipt
  → verificación
  → review | blocked | doing
```

El contrato incluye:

- descubrimiento por `ExecutionProfile`;
- raíz, Feature, perfil, `runId` y señal de cancelación como inputs;
- permisos declarativos, sin acceso implícito a secretos;
- resultado `completed`, `verification_failed`, `blocked`, `needs_human` o
  `cancelled`;
- aislamiento y timeouts responsabilidad del adapter concreto;
- ninguna transición de estado ni autoaprobación dentro del adapter.

Se implementan un `DeterministicExecutionAdapter` para tests y fixtures y un
adapter opt-in para Pi mediante su protocolo RPC documentado (`pi --mode rpc
--no-session`). El adapter Pi solo maneja perfiles `direct`; el adapter
específico de `pi-spec-flow` queda fuera hasta verificar la extensión/API
instalada y definir su configuración explícita.

## Consecuencias

- El core puede probarse sin Pi, red o procesos externos.
- `run` puede detenerse con `engine_unavailable` sin mover una Feature.
- Añadir otro motor real no requiere duplicar reglas de dominio.
- La integración `pi-spec-flow` necesita una decisión posterior sobre su
  extensión/API, permisos, aislamiento y cancelación.
