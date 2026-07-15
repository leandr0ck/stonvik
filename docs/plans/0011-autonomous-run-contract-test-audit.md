# Auditoría 0011: trazabilidad del contrato autónomo y pruebas

**Estado:** Abierto — hallazgos bloquean declarar cubierto el contrato de
`forgium run`  
**Fecha:** 2026-07-14  
**Contrato normativo:** [ADR 0008](../adr/0008-autonomous-agent-run-loop.md) y
[Objetivo técnico 0010](0010-autonomous-agent-loop-objective.md)

## Propósito y fuente de verdad

El contrato de la aplicación ya está definido de forma normativa por ADR 0008
y, en detalle verificable, por los requisitos funcionales, no funcionales y
criterios AC-1…AC-26 del Objetivo 0010. No se duplica en un segundo documento
de requisitos: duplicarlo permitiría que dos contratos divergieran.

Este documento es el registro de trazabilidad entre ese contrato y la evidencia
de pruebas. Una fila marcada como **parcial** o **ausente** no autoriza a decir
que el requisito está cubierto, aunque `npm test` esté verde.

### Definiciones de evidencia

| Estado | Significado |
| --- | --- |
| **Cubierto** | Una prueba automatizada ejerce exactamente el comportamiento y observa el resultado contractual. |
| **Parcial** | Prueba una parte, pero omite una condición, una salida o la interfaz pública exigida. |
| **Ausente** | No hay prueba trazable del requisito. |

Un E2E de CLI debe arrancar un proceso de la CLI compilada, usar únicamente
comandos públicos y un doble externo de Pi cuando sea offline. Un test que
inyecta `classify`, llama `AgentLoop`, usa `FilesystemForgiumRepository` o
modifica el estado de Forgium desde Vitest es integración de componentes, no
un E2E de contrato. Esta distinción viene del Plan 0008.

## Contrato operativo auditado

1. `forgium run` es el orquestador principal y procesa, en orden, Work activa,
   definiciones pendientes, Inbox por fecha/ID y la siguiente Work ready.
2. La clasificación Pi no es autoridad de estado: debe ser un objeto válido del
   schema. Todo payload malformado, incompleto o incoherente falla cerrado, no
   muta Inbox/Work, deja un `RunEvent` durable y devuelve una acción siguiente
   accionable.
3. Solo una clasificación XS/S sin riesgo, con confianza suficiente, puede
   promover automáticamente. Los demás tamaños/riesgos requieren decisión o
   definición humana; XL se divide.
4. Las definiciones humanas no son Work ejecutable y requieren validación y
   confirmación humana antes de crear una Work ready.
5. La ejecución, la verificación y la review son gates separados: no existe
   transición `doing → done`; el implementador no autoaprueba.
6. Toda detención expone `stopReason`, IDs afectados y `nextAction` consistente
   tanto en salida humana como JSON; los campos de definición sólo pueden
   aparecer cuando existen `definitionKind` y `definitionRef` reales.
7. `--watch` espera un cambio durable antes de reintentar y es interrumpible sin
   corromper estado. La salida JSON en watch es NDJSON exclusivamente.

El punto 6 incluye el incidente de 2026-07-14: una clasificación inválida creó
una acción `classification_invalid` con `nextAction`. La CLI la convirtió
erróneamente en `definitionRef`, renderizando `Definition required: undefined`.

## Inventario de pruebas actual y límite observado

| Prueba | Lo que realmente ejerce | Límite |
| --- | --- | --- |
| `autonomous-run-loop.test.ts` | `AgentLoop` con clasificación y adapters deterministas inyectados. | No lanza CLI ni `PiClassificationAdapter`; no es E2E de contrato. |
| `product-loop-e2e.test.ts` | CLI de triage manual usando `t`, `s` y `a` por stdin. | Sin `FORGIUM_PI_COMMAND`, `run` entra en el fallback `triage`; no ejecuta el loop autónomo. |
| `run-cli.test.ts` | Fallback no interactivo, Work ready, dry-run, concurrencia y una clasificación Pi inválida con un ejecutable RPC falso. | Tests de estados de recuperación; no sustituyen el recorrido completo. |
| `cli-contract-e2e.test.ts` | CLI compilada + Pi RPC falso: auto-XS, clasificación inválida, gate humano, XL, verificación fallida y review con cambios. | La definición humana confirmada aún necesita recorrido completo con editor fixture. |
| `watch-cli-e2e.test.ts` | CLI compilada + `run --watch --json`: idle, captura durable, NDJSON y SIGTERM. | No cubre ejecución Pi durante watch. |
| `agent-boundary.test.ts` | Prompts de clasificación, ejecución y Spec Flow delimitan contenido no confiable y estado Forgium. | No es una prueba de sandbox de proceso del sistema operativo. |
| `implementation-observation-e2e.test.ts` | Comando público `implement` con un Pi falso para Spec Flow. | No invoca `forgium run` ni clasificación. |
| `real-run-e2e.test.ts` | CLI compilada + ejecutable Pi real en RPC, con proveedor fixture local determinista, desde `capture` hasta `done`. | Cubre una intención XS y el protocolo Pi, no la calidad/no determinismo de un modelo remoto. |
| `pi-spec-flow-implement-e2e.test.ts` | Pi real opt-in para `implement`; espera fallo cerrado sin status estructurado. | No prueba un flujo completo `run` ni una finalización real. |

Por tanto, los nombres `autonomous` o `product-loop-e2e` no prueban por sí
solos el contrato de los puntos 1–7.

## Matriz requisito → evidencia

| Criterio de Objetivo 0010 | Estado | Evidencia actual | Gap necesario |
| --- | --- | --- | --- |
| AC-1 auto-XS válido promueve Work | Cubierto | `cli-contract-e2e.test.ts`: CLI compilada + Pi RPC falso + efecto observable + receipts + validate. | Añadir cobertura de selección entre varias ready. |
| AC-2 no automático pide decisión | Cubierto | `cli-contract-e2e.test.ts`: clasificación M/ask_spec, stdin `s`, definición y sin ready Work. | Añadir variante de riesgo sobre XS/S. |
| AC-3 XL exige división | Cubierto | `cli-contract-e2e.test.ts`: clasificación XL, stdin `p`, sin Work creada. | Ninguno para la ruta básica. |
| AC-4 payload inválido falla cerrado | Cubierto | `run-cli.test.ts` y `cli-contract-e2e.test.ts`: Pi RPC falso emite payload inválido; aserta Inbox sin mutar, gate durable, `stopReason`, `nextAction` y ausencia de `Definition required`. | Ninguno para la regresión actual. |
| AC-5 definición no ejecutable | Cubierto | `cli-contract-e2e.test.ts`: `run` crea definición, `definition edit` la completa y no aparece como ready antes de confirmación. | Ninguno para la ruta básica. |
| AC-6 confirmación de definición válida | Cubierto | `cli-contract-e2e.test.ts`: editor fixture + `definition edit` + `run` con confirmación `c` produce Work done. | Añadir rollback explícito si falla la promoción. |
| AC-7 selección determinista de ready | Ausente | — | Dos Work ready con fechas/IDs controlados, ejecutadas por `run`. |
| AC-8 Spec Flow pendiente conserva doing | Parcial | `implementation-observation-e2e.test.ts` | Incorporar al E2E de `run`. |
| AC-9 Spec Flow completo llega a review | Parcial | `implementation-observation-e2e.test.ts` | Lo cubre `implement`, no `run`. |
| AC-10 verificación fallida no llega a review/done | Cubierto | `cli-contract-e2e.test.ts` y `receipts-review.test.ts`. | Añadir aserción completa de handoff en CLI compilada. |
| AC-11 review independiente aprueba → done | Cubierto | `cli-contract-e2e.test.ts` con adapter Pi RPC de review separado. | Ninguno para la ruta directa. |
| AC-12 review pide cambios → doing | Cubierto | `cli-contract-e2e.test.ts`: reviewer pide cambios y segunda invocación retoma Work. | Añadir prioridad con otra ready Work. |
| AC-13 implementador no autoaprueba | Ausente | — | Prueba de frontera que demuestre rechazo/persistencia controlada. |
| AC-14 una invocación de run orquesta hasta gate/idle | Cubierto | `cli-contract-e2e.test.ts`. | Añadir recorrido Spec Flow bajo `run`. |
| AC-15 gates informan estado, ID, reason y next action | Cubierto para gates implementadas | Clasificación inválida, XL, definición, bloqueo y review en E2E compilado; JSON y humano asertados. | Añadir una prueba de señal durante implementación para completar recuperación. |
| AC-16 múltiples doing se detiene | Parcial | `run-cli.test.ts` crea dos estados doing y aserta `multiple_active_work`. | Convertir setup a fixture de procesos públicos. |
| AC-17 watch espera cambio durable | Cubierto | `watch-cli-e2e.test.ts` captura después de idle y observa exactamente el segundo pass. | Añadir prueba de cambio irrelevante. |
| AC-18 señales dejan estado reanudable | Parcial | `watch-cli-e2e.test.ts` termina con SIGTERM y valida árbol. | Probar señal durante ejecución Pi activa. |
| AC-19 watch JSON es sólo NDJSON | Cubierto | `watch-cli-e2e.test.ts` parsea cada línea como JSON. | Ninguno para el modo base. |
| AC-20 schemas/artefactos inválidos se rechazan atómicamente | Parcial | tests de repositorio, receipts y clasificación inválida. | Añadir matriz de rollback de definición/manifest. |
| AC-21 contenido malicioso no mueve estado ni escapa paths | Parcial | `agent-boundary.test.ts` valida prompts y límites; tests de adapters validan paths. | Añadir proceso malicioso que intente tocar `features/`. |
| AC-22 quality gates | Cubierto | `npm test`, `typecheck`, `build`, `diff --check` | Ejecutar en CI; no demuestra los AC ausentes. |
| AC-23 cada gate tiene receipt o RunEvent suficiente | Parcial | receipts/observación de ejecución | E2E de todas las gates, comenzando por clasificación inválida. |
| AC-24 documentación pública actualizada | Parcial | ADR/plan/documentación | Revisión de README/help contra contrato y prueba de ayuda si aplica. |
| AC-25 E2E compilado de los escenarios listados | Parcial | `cli-contract-e2e.test.ts`, `watch-cli-e2e.test.ts`. | Faltan definición confirmada completa, Spec Flow bajo run, bloqueo y algunas señales. |
| AC-26 E2E real Pi + Spec Flow | Parcial | `real-run-e2e.test.ts` arranca en `capture` y cubre el recorrido directo completo con proceso Pi real y proveedor fixture; `pi-spec-flow-implement-e2e.test.ts` es el canario de modelo real para la observación de Spec Flow. | Falta un recorrido completo `capture → definición → Spec Flow → review` con Pi real. |

## Resultado de la revisión

La suite actual ya tiene infraestructura compilada, un recorrido directo
offline, gates de clasificación, verificación, review y watch. AC-26 tiene ya
un gate real opt-in que usa `run`; AC-15 y AC-25 siguen parciales por los
escenarios de definición/editor, bloqueo y señal durante implementación que aún
no tienen una prueba pública completa.

El fix de renderizado del incidente está protegido por una prueba de regresión.
La prioridad restante es cerrar definición confirmada, bloqueo/selección,
señal durante ejecución, el proceso malicioso de AC-21 y un flujo real
Spec Flow desde Inbox; el gate real se ejecuta con `npm run test:e2e:real`
antes de release.

## Gate de cierre de esta auditoría

Esta auditoría sólo puede marcarse completada cuando cada fila tenga una prueba
trazable y los scripts de CI separen claramente:

```bash
npm test                    # unitarias, integración y E2E offline de CLI
npm run test:e2e:real       # Pi directo + pi-spec-flow; opt-in por coste
```

No debe restaurarse una afirmación de cobertura total basándose sólo en que la
suite por defecto está verde.
