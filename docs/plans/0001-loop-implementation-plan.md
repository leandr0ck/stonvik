# Plan 0001: Implementación del loop de Forgium

**Estado:** Propuesto  
**Fecha:** 2026-07-12  
**Basado en:** ADR 0001–0004

## Objetivo

Entregar `forgium run` como el punto único de entrada para transformar trabajo
aprobado en una Feature revisada, con estado durable, límites seguros y
evidencia de ejecución. La entrega se divide para que el modelo de datos y las
garantías de calidad existan antes de ejecutar agentes de forma autónoma.

## Principios de entrega

- Cada fase mantiene compatibilidad con los repositorios Forgium existentes.
- El estado y sus transiciones se implementan antes de prompts o integración
  con agentes.
- Una fase solo habilita más autonomía cuando sus checks y tests existen.
- Ninguna fase introduce retries ilimitados, ejecución paralela o autoaprobación.

## Fase 0 — Alinear la base documental

**Resultado:** las decisiones son localizables y la especificación histórica
deja de ser ambigua.

- Mantener `docs/README.md` como índice de ADRs y planes.
- Referenciar los ADRs desde `README.md` y `loop-technical-spec.md`.
- Resolver contradicciones puntuales de estados y cierre de Features en la
  especificación original.

**Criterio de salida:** los ADRs 0001–0004 son la fuente normativa declarada.

## Fase 1 — Modelo durable de Drafts

**Resultado:** una solicitud aprobada puede convertirse en un Draft editable
sin crear una Feature inválida o ejecutable.

**Cambios principales**

- Crear `features/draft/` durante `forgium init`.
- Añadir tipos `Draft`, `DraftFrontmatter` y los estados Inbox `drafted` y
  `draftRef`.
- Implementar `DraftSchema` y lectura/escritura atómica de `draft.md`.
- Añadir APIs de repositorio: listar, leer, crear desde Inbox y promover Drafts.
- Generar `manifest.yaml` solo al promover un Draft válido a `ready`.
- Extender `forgium validate` y `forgium status` para Drafts.

**Verificación**

- Crear Draft desde Inbox conserva título, cuerpo y referencia de origen.
- Draft incompleto no puede pasar a `ready`.
- Promoción válida mueve el directorio, genera un manifest válido y actualiza
  el Inbox a `promoted` con ambas referencias.
- Una colisión de slug o un fallo de escritura no deja estado parcial.

## Fase 2 — Triage interactivo

**Resultado:** el operador puede limpiar el Inbox y completar Drafts sin
editar manualmente estructuras internas.

**Cambios principales**

- Añadir `forgium triage` como primitiva que recorre Drafts y luego Inbox.
- Implementar acciones de editar, promover, aprobar, diferir, mezclar, saltar
  y salir conforme al ADR 0003.
- Abrir `$VISUAL` y luego `$EDITOR` mediante ejecución sin shell; informar un
  error claro si no hay editor disponible.
- Añadir `--non-interactive`, `--edit`, `--json` y `--dry-run` donde aplique.

**Verificación**

- Las entradas simuladas producen exactamente las transiciones esperadas.
- `--non-interactive` nunca promociona Inbox `captured`.
- Una interrupción deja los artefactos existentes válidos y retomables.

## Fase 3 — Receipts y review verificable

**Resultado:** cada intento y cada decisión de review dejan evidencia durable.

**Cambios principales**

- Añadir esquemas y tipos de receipt (`execution`, `verification`, `review`,
  `handoff`).
- Implementar escritura append-only en `receipts/` y validar referencias
  locales.
- Extender el manifest con una política de verificación opcional compatible.
- Añadir ejecución acotada de checks, redacción de output y receipts de
  verificación.
- Actualizar `forgium review` para exigir y registrar `approved`,
  `changes_requested` o `blocked`.

**Verificación**

- Checks exitosos/fallidos y evidencia ausente generan las transiciones del
  ADR 0004.
- `review → done` siempre genera receipt; `doing → done` sigue rechazado.
- Los receipts son inmutables, válidos y no contienen secretos o logs extensos.

## Fase 4 — Orquestador `forgium run`

**Resultado:** un único comando compone triage, promoción y selección de
Feature con límites explícitos.

**Cambios principales**

- Implementar preflight, presupuesto `maxFeatures`, `--until-empty`,
  `--dry-run`, stop reasons y salida JSON.
- Reutilizar las primitivas de triage, promoción y transiciones ya probadas.
- Crear y limpiar leases bajo `.forgium/runtime/` solo al iniciar ejecución.
- Manejar `SIGINT` y `SIGTERM` con handoff receipt y estado retomable.

**Verificación**

- Sin opciones, el comando ejecuta como máximo una Feature elegible.
- `--until-empty` se detiene ante trabajo no elegible, gates humanos, bloqueos
  o presupuesto agotado; no intenta borrarlos.
- Un fallo de preflight no modifica el repositorio.

## Fase 5 — Contrato e integración de motores de ejecución

**Resultado:** `run` puede ejecutar una Feature de punta a punta sin que el
orquestador conozca detalles de Pi o `pi-spec-flow`.

**Decisión pendiente antes de implementar:** documentar un contrato de
`ExecutionAdapter`: descubrimiento, configuración, permisos, inputs,
resultados tipados, aislamiento y cancelación.

**Cambios principales**

- Definir la interfaz `ExecutionAdapter` y un adaptador de prueba determinista.
- Implementar adaptadores para ejecución directa con Pi y Features guiadas por
  `pi-spec-flow`.
- Validar disponibilidad del motor antes de `ready → doing`.
- Traducir resultados del adaptador a receipts, verificación y transiciones.

**Verificación**

- Un adaptador ausente no mueve una Feature a `doing`.
- Cada resultado tipado sigue las reglas de ADR 0003 y ADR 0004.
- Una cancelación conserva handoff y permite reanudar en una ejecución futura.

## Fase 6 — End-to-end y endurecimiento

**Resultado:** un repositorio de ejemplo puede recorrer Inbox → Draft → Ready
→ Doing → Review → Done con evidencia verificable.

- Añadir fixtures de repositorios con Drafts, colisiones, receipts inválidos y
  interrupciones.
- Añadir pruebas CLI end-to-end en repositorios sin Git y con Git.
- Probar compatibilidad con Features creadas por la CLI existente.
- Actualizar README, ayuda de CLI y `loop-technical-spec.md` con los nombres
  definitivos de comandos y artefactos.

**Criterio de salida:** `forgium run` deja un resumen reproducible y ninguna
Feature alcanza `done` sin review y receipts válidos.

## Dependencias y orden

```text
Fase 0 → Fase 1 → Fase 2
                 ├→ Fase 3 → Fase 4 → Fase 5 → Fase 6
                 └─────────────────────────────────────┘
```

La Fase 5 depende de una decisión específica sobre el adaptador de ejecución.
Las Fases 1–4 no deben simular una implementación autónoma si ese contrato no
está definido.

## Fuera de este plan inicial

- Daemon, cron y webhooks.
- Worktrees y ejecución paralela.
- Priorización por impacto o coste.
- Autoaprobación por LLM y retries ilimitados.
