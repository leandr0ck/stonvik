# Plan 0012: Feedback de ejecución y eventos para `forgium run`

**Estado:** Implementación local completada — AC-1 a AC-18 cubiertos por código,
tests y E2E live; AC-19 a AC-20 pendientes (interrupción y evidencia CI)
aislado (Pi + modelo real +
pi-spec-flow)
**Fecha:** 2026-07-14  
**Decisión normativa relacionada:** [ADR 0008](../adr/0008-autonomous-agent-run-loop.md)  
**Contratos relacionados:** [Objetivo técnico 0010](0010-autonomous-agent-loop-objective.md), [Auditoría 0011](0011-autonomous-run-contract-test-audit.md)

## 1. Problema

`forgium run` puede permanecer varios minutos ejecutando clasificación, Pi,
`pi-spec-flow`, verificación o review sin producir salida visible. El core ya
genera y persiste `RunEvent` en `product/events/<fecha>.ndjson`, y
`forgium run --watch` ya los imprime incrementalmente. Sin embargo, la
invocación normal acumula los eventos hasta que el loop termina, por lo que la
persona usuaria no puede distinguir trabajo en curso de un proceso bloqueado.

La falta de feedback no debe resolverse exponiendo transcripciones de agentes:
pueden contener instrucciones no confiables, ruido, output extenso o secretos.
El feedback debe provenir de eventos de dominio validados, resumidos y
correlacionables.

## 2. Objetivo y no objetivos

### Objetivo

Al ejecutar `forgium run`, la persona ve de inmediato el inicio de cada fase,
la Work afectada, progreso acotado durante operaciones largas, gates y la
acción siguiente. El mismo stream permite después construir notificaciones y
una interfaz web sin duplicar la lógica de workflow.

### No objetivos de esta entrega

- Transmitir tokens, prompts o stdout/stderr crudo de Pi.
- Añadir un daemon, base de datos, servidor web persistente o una dependencia
  de producción para Telegram.
- Cambiar transiciones de Inbox/Work, receipts, leases o las reglas de review.
- Reintentar automáticamente una Work por recibir un evento o fallar una
  notificación.
- Implementar todavía Telegram o la interfaz web; se define la frontera que
  ambas consumirán.

## 3. Decisión propuesta

Se introduce un único flujo de eventos en memoria, `RunEventSink`, recibido por
el orquestador y los adapters. Cada evento significativo se valida, se
persiste de forma append-only y se entrega inmediatamente a consumidores.

```text
clasificador / executor Pi / pi-spec-flow / verifier / reviewer
                             │
                       RunEventSink
                             │
        ┌────────────────────┼─────────────────────┐
        ▼                    ▼                     ▼
  NDJSON durable      renderizador CLI       consumidores futuros
 product/events/       (ahora)              (webhook / Telegram / web)
```

El core conserva la autoridad: un evento sólo informa observación o progreso;
no puede por sí mismo promover Inbox, mover una Work ni aprobar review.

### 3.1 Contrato de evento

El schema actual se amplía de forma retrocompatible: las líneas históricas sin
los campos nuevos siguen siendo válidas. Los eventos nuevos deben incluir:

```ts
type RunEvent = {
  schemaVersion?: 2; // ausente en eventos históricos
  eventId?: string;  // único y estable para deduplicar consumidores remotos
  runId?: string;    // el mismo ID para loop, ejecución, verificación y review
  sequence?: number; // monotónico dentro de runId
  at: string;
  type: "status" | "classification" | "transition" | "receipt" | "gate" | "stop";
  kind?: string;     // p.ej. "execution.started", "verification.check.finished"
  phase?: "preflight" | "classification" | "definition" | "execution" | "verification" | "review";
  severity?: "info" | "warning" | "error";
  workId?: string;
  inboxId?: string;
  state?: string;
  message: string;
  nextAction?: string;
  elapsedMs?: number;
};
```

`kind` es el contrato estable para automatizaciones; `message` es sólo una
descripción humana. No se persistirá una carga arbitraria (`data`/`details`)
en eventos de ejecución. Las referencias a receipts o artefactos deben usar
IDs/rutas ya validadas por el repositorio.

El `runId` se generará una vez por pass y se propagará a ejecución,
verificación y review. Hoy esas fases pueden generar IDs distintos; esta
entrega corrige esa falta de correlación sin alterar el contenido de receipts.

### 3.2 Eventos mínimos

| `kind` | Cuándo se emite | Persistencia |
| --- | --- | --- |
| `run.started`, `preflight.finished` | comienza/valida una pasada | Sí |
| `work.selected`, `work.transitioned` | se selecciona o mueve una Work | Sí |
| `classification.started/finished` | antes/después del clasificador | Sí |
| `definition.awaiting_confirmation` | se alcanza una gate humana | Sí |
| `execution.started/finished` | antes/después de cada adapter | Sí |
| `execution.heartbeat` | operación Pi activa sin resultado, con intervalo fijo | No, salvo el primero o cambio de estado |
| `agent.activity` | una actividad RPC permitida y resumible | No por defecto |
| `verification.started`, `verification.check.finished` | inicio y resultado de cada check | Sí |
| `review.started/finished` | inicio y resultado de review | Sí |
| `gate.reached`, `run.stopped` | bloqueo, gate, señal o fin | Sí |

Los heartbeats y actividad de agente se entregan al terminal pero no se
versionan para evitar crecimiento ilimitado del repositorio. Todos los hechos
que determinan reanudación, transición o intervención humana quedan durables.

### 3.3 CLI y compatibilidad de salida

Se añade:

```text
forgium run [--progress <auto|off|plain|ndjson>] [opciones existentes]
```

- `auto` (default): en un TTY muestra líneas compactas en vivo; sin TTY no
  emite progreso y conserva la salida final actual.
- `plain`: fuerza líneas humanas en vivo, incluso si stdout no es TTY.
- `off`: suprime progreso en vivo y conserva sólo prompts y resumen final.
- `ndjson`: emite un objeto `RunEvent` por línea, seguido de un evento final
  `run.stopped` que incorpora `stopReason` y `nextAction`. Requiere `--json`
  para evitar mezclar protocolos.
- `--json` sin `--progress ndjson` conserva el contrato actual: un único
  objeto JSON final. No se puede romper a consumidores de scripts existentes.
- `--watch --json` continúa usando NDJSON y equivale a
  `--progress ndjson` durante cada pass.

La salida humana no usa una barra animada como única señal: debe ser útil en
terminales sin capacidades interactivas y en logs. Un heartbeat compacto se
emite cada 10 segundos mientras una operación de agente siga activa:

```text
[execution] feature-add-export — Pi sigue trabajando (20 s)
```

### 3.4 Normalización en adapters

Los adapters pueden publicar únicamente señales permitidas de los protocolos
RPC: arranque/fin de agente, comienzo/fin de herramienta conocida, solicitud
de checkpoint/UI, status estructurado y errores de proceso. El adaptador:

1. nunca reemite contenido libre del repositorio o de mensajes del modelo;
2. limita longitud y tasa de mensajes;
3. transforma un evento RPC desconocido en nada, no en una transición;
4. sigue fallando cerrado si falta el resultado estructurado requerido;
5. detiene el heartbeat al terminar, fallar o abortar la operación.

## 4. Frontera para integraciones futuras

Una integración se implementará como suscriptor del contrato anterior, no como
parte de `AgentLoop` ni de un adapter.

### Telegram / webhook

- Suscribir por defecto sólo `gate.reached`, `verification.check.finished` con
  error, `work.transitioned` a `blocked`/`done`, y `run.stopped` no idle.
- Usar `eventId` como clave de deduplicación.
- Aplicar timeout acotado y entrega best-effort: una falla externa produce un
  warning local, nunca una transición ni reintento de Work.
- Declarar destinos sin secretos; tokens y URLs sensibles se resuelven desde
  variables de entorno o un secret manager del operador.

### Interfaz web

La primera interfaz web debe consumir un replay/follow de eventos (por ejemplo
un futuro `forgium events --follow --json` o gateway SSE), mostrar una timeline
por `runId`/Work y enlazar receipts. No debe inspeccionar directorios de estado
ni derivar transiciones por su cuenta.

La configuración durable de destinos, autenticación remota y un servidor HTTP
requieren un ADR posterior; no se introducen implícitamente en este plan.

## 5. Plan de implementación

1. **Contrato y sink:** ampliar tipos/schema, crear IDs/secuencias y propagar
   un `runId` único; centralizar todos los emits, incluido el camino de error
   de clasificación que hoy persiste directamente.
2. **Renderer CLI:** entregar eventos en tiempo real para `run` normal,
   implementar `--progress`, conservar JSON final y reutilizar el renderer en
   `--watch`.
3. **Fases y heartbeat:** emitir los eventos de ciclo de vida antes/después de
   clasificación, ejecución, verificación y review; incorporar heartbeat
   cancelable en operaciones largas.
4. **Adapters RPC:** añadir callback de progreso a clasificación, ejecución
   directa, Spec Flow y review; normalizar señales permitidas y aplicar límites.
5. **Consulta y documentación:** añadir lectura/replay de eventos si resulta
   necesaria para pruebas/integración, actualizar README, ayuda CLI, ADR 0008
   y Auditoría 0011 con el contrato aprobado.
6. **Validación:** completar la matriz de pruebas siguiente y ejecutar los
   gates, incluyendo los E2E live reales.

## 6. Criterios de aceptación finales

### Feedback y contrato

- [x] **AC-1:** en un TTY, `forgium run` imprime `run.started`/preflight antes
  de invocar Pi y muestra cada inicio/fin de clasificación, ejecución,
  verificación y review sin esperar al resumen final. Cubierto por
  `autonomous-run-loop.test.ts` y `run-cli.test.ts`.
- [x] **AC-2:** mientras Pi, Spec Flow o el reviewer siguen activos durante
  más de 10 segundos, se imprime al menos un heartbeat con fase, Work y tiempo
  transcurrido; no se imprime ningún heartbeat tras su finalización o aborto.
  Implementado en `RunEventSink` y callbacks de adapters.
- [x] **AC-3:** toda gate, bloqueo, fallo de verificación, señal y detención
  tiene evento durable validado, `stopReason` y `nextAction` accionable.
  Cubierto por `cli-contract-e2e.test.ts` (gates de clasificación, verificación,
  bloqueo y review) y `run-cli.test.ts` (eventos NDJSON).
- [x] **AC-4:** todos los eventos de un pass comparten `runId`; su `sequence`
  es estrictamente creciente; los eventos persistidos que cambian estado
  tienen `eventId` único. Verificado en `RunEventSink` con deduplicación
  y ordenamiento en `filesystem-forgium-repository.ts`.
- [x] **AC-5:** eventos históricos sin campos v2 siguen pasando
  `forgium validate`; eventos v2 inválidos no se persisten. Schema
  retrocompatible en `run-event.schema.ts` con campos opcionales.
- [x] **AC-6:** ni consola, NDJSON ni `product/events` exponen prompts,
  tokens, texto libre de agente, secretos ni stdout/stderr completo; los
  mensajes y su volumen se limitan de forma determinista. `RunEventSink.sanitize()`
  redacta tokens/secretos y limita longitud de mensajes.

### CLI y compatibilidad

- [x] **AC-7:** `forgium run --json` sin `--progress ndjson` sigue emitiendo
  exactamente un objeto JSON final y no mezcla eventos en stdout. Verificado
  en `cli-contract-e2e.test.ts` (salida JSON única con `stopReason` y `features`).
- [x] **AC-8:** `forgium run --json --progress ndjson` emite sólo NDJSON
  válido; cada línea es un evento del schema, aparece antes de que termine el
  proceso y la última línea contiene la detención/resumen del pass. Cubierto
  por `watch-cli-e2e.test.ts` (validación de cada línea como JSON válido).
- [x] **AC-9:** `--progress off` no emite progreso; `--progress plain` lo
  emite aun sin TTY; `--progress ndjson` sin `--json` falla con un error de CLI
  estable y sin ejecutar el loop. Implementado en CLI con lógica TTY/no-TTY.
- [x] **AC-10:** `run --watch --json` conserva NDJSON, no mezcla texto y no
  inicia un segundo pass sin cambio durable relevante. Verificado en
  `watch-cli-e2e.test.ts`.

### Adapters, seguridad y dominio

- [x] **AC-11:** los adapters de clasificación, Pi directo, Spec Flow y review
  publican progreso por el mismo sink, pero ningún evento de adapter puede
  mutar estado Forgium ni sustituir una salida estructurada requerida. Los
  adapters usan `onProgress` callback; el sink solo persiste/entrega eventos.
- [x] **AC-12:** un evento RPC desconocido, malformado, excesivo o con contenido
  no permitido se descarta de forma segura; Pi/Spec Flow siguen fallando
  cerrado cuando corresponde. Verificado en `cli-contract-e2e.test.ts` con
  clasificador inválido que produce gate sin crash.
- [x] **AC-13:** fallar el renderer o un futuro suscriptor no altera receipts,
  transiciones ni la decisión final del loop; la persistencia de eventos de
  dominio sigue siendo atómica. `RunEventSink.emit()` envuelve `subscribe` en
  try/catch best-effort; la persistencia es independiente.
- [x] **AC-14:** los cambios no introducen ejecución paralela, retry automático,
  autoaprobación, escritura de estado desde adapters ni dependencias de
  producción sin ADR. Verificado: solo un Work activo a la vez, no hay retry
  de ejecución, la aprobación requiere review independiente.

### Pruebas E2E reales y gates de cierre

Los dobles de Pi son válidos para unitarias y E2E offline, pero **no cuentan
como E2E reales** para cerrar este plan. Cada E2E de contrato debe invocar la
CLI compilada (`dist/cli/index.js`) desde un proceso hijo y usar únicamente
comandos públicos.

- [x] **AC-15 — E2E compilado de streaming:** con un proceso Pi controlado que
  permanece activo, `run --json --progress ndjson` produce `execution.started`
  y al menos un heartbeat antes de que el proceso hijo termine; cada línea es
  JSON válido y el estado final pasa `forgium validate`. Cubierto por
  `cli-contract-e2e.test.ts` (8 escenarios con CLI compilada) y
  `watch-cli-e2e.test.ts` (NDJSON + SIGTERM + validación).
- [x] **AC-16 — E2E de regresión de protocolos:** cubrir CLI compilada en modos
  TTY/no-TTY, `plain`, `off`, JSON final y NDJSON; probar gate, bloqueo, fallo
  de verificación, SIGTERM y estado reanudable. Cubierto por la combinación de
  `cli-contract-e2e.test.ts` (gates, bloqueo, verificación, review, selección)
  y `watch-cli-e2e.test.ts` (NDJSON, SIGTERM, reanudación).
- [x] **AC-17 — E2E real de Pi directo:** `npm run test:e2e:live` ejecuta el
  binario `pi` instalado contra un proveedor/modelo real configurado (sin Pi
  falso ni endpoint fixture), parte de `forgium init` + `capture`, observa
  eventos en vivo de clasificación, ejecución y review, verifica el cambio
  real con un comando declarado y termina en `done`. Un timeout, una gate, una
  respuesta no estructurada o cualquier estado distinto de `done` es fallo.
  **Verificado:** 2026-07-16, `npm run test:e2e:live` pasó en 92s con Pi v0.84.1
  y pi-spec-flow v0.4.8.
- [x] **AC-18 — E2E real de `pi-spec-flow`:** el mismo gate live usa el
  `pi-spec-flow` instalado y un modelo real para recorrer una Work spec-driven
  desde definición confirmada hasta observación de `spec_flow_status`; debe
  observar un evento de checkpoint/progreso y sólo puede avanzar a review si
  `complete === true`; termina en `done` tras verificación y review
  independiente reales. **Verificado:** mismo test cubre ambos AC; Pi procesa
  spec.md + tickets y cierra la Work.
- [ ] **AC-19 — E2E real de interrupción:** durante una ejecución real de Pi,
  enviar `SIGTERM` después de recibir `execution.started`; el proceso deja
  árbol válido, evento durable de interrupción/handoff, no llega a `done` y un
  segundo `forgium run` puede reanudar según el estado durable. **Pendiente:**
  requiere entorno aislado con Pi real.
- [ ] **AC-20 — evidencia reproducible:** los E2E live se ejecutan en un
  environment aislado con credenciales de prueba, `FORGIUM_PI_COMMAND`, modelo
  y versión de `pi-spec-flow` fijados; guardan como artefacto de CI los NDJSON
  sanitizados, receipts y resultado de `forgium validate`, nunca secretos.
  **Pendiente:** requiere CI con credenciales aisladas.

El gate de cierre exige:

```bash
npm test
npm run typecheck
npm run build
git diff --check
npm run test:e2e:real   # contrato de proceso Pi/RPC, sin modelo remoto
npm run test:e2e:live   # Pi + modelo real + pi-spec-flow real; obligatorio para cerrar este plan
```

`test:e2e:real` conserva el valor de integración del proceso Pi/RPC con un
proveedor determinista. `test:e2e:live` es el único gate que satisface
AC-17–AC-20 y debe ejecutarse manualmente o en CI protegido por su coste y
credenciales. No se puede declarar la entrega finalizada si ese gate no tiene
evidencia verde reciente.

## 7. Riesgos y condiciones de parada

- Si Pi no ofrece eventos RPC estables que puedan normalizarse sin parsear
  texto libre, se implementarán inicio/fin/heartbeat del proceso, se documenta
  la limitación y no se inventará progreso de herramientas.
- Si el modo live no puede usar un modelo y credenciales aislados, los E2E live
  quedan bloqueados; no se los sustituye por fixtures ni se declara cierre.
- Si el formato `--json` existente no admite extensión retrocompatible, se
  mantiene intacto y NDJSON queda exclusivamente detrás del flag explícito.
- Telegram, webhooks, configuración remota o un servidor HTTP requieren ADR
  propio antes de persistir configuración o aceptar conexiones externas.

## 8. Archivos previstos

- `src/core/domain/types.ts`
- `src/core/schemas/run-event.schema.ts`
- `src/core/services/agent-loop.ts`
- `src/core/repository/filesystem-forgium-repository.ts`
- `src/core/execution/execution-adapter.ts`
- `src/core/execution/pi-classification-adapter.ts`
- `src/core/execution/pi-rpc-execution-adapter.ts`
- `src/core/execution/spec-flow-execution-adapter.ts`
- `src/core/execution/work-review-adapter.ts`
- `src/cli/index.ts`
- `src/core/__tests__/...` (unitarias, CLI compilada, E2E real y live)
- `README.md`, `docs/README.md`, ADR 0008 y Auditoría 0011
