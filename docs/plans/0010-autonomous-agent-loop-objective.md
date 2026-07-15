# Objetivo técnico 0010: Loop autónomo de agentes de Forgium

**Estado:** Aprobado para implementación  
**Fecha:** 2026-07-14  
**Decisión normativa:** [ADR 0008](../adr/0008-autonomous-agent-run-loop.md)

## 1. Resultado esperado

Después de `forgium init`, una persona puede ejecutar solamente:

```bash
forgium run
```

Forgium muestra el estado inicial y opera el loop completo: procesa intención
de producto, usa agentes para el trabajo de bajo riesgo, pide a una persona la
decisión o definición que no puede inferir de forma segura, implementa,
verifica, revisa de forma independiente y continúa con la siguiente Work. Se
detiene al vaciar el trabajo elegible o al encontrar una gate/bloqueo. Con
`forgium run --watch` queda activo, informa cambios y reanuda solo después de
detectar una modificación durable relevante.

El objetivo no es ocultar gates: es que la persona no tenga que saber qué
comando interno sigue ni coordinar agentes manualmente.

## 2. Alcance y no alcance

### Incluido

- Orquestación end-to-end desde Inbox hasta `done` mediante `run`.
- Clasificación Pi estructurada con sizing y política de riesgo determinista.
- Definición humana de Spec/ADR en una carpeta de definición de la futura Work.
- Implementación directa Pi para Work trivial y observación `pi-spec-flow` para
  Work spec-driven.
- Verificación obligatoria, review de Work independiente y receipts.
- `--watch`, estado incremental humano y eventos JSON para automatización.
- API, documentación, tests unitarios/integración/E2E y gates de calidad.

### Excluido

- Paralelizar Work o continuar con otra Work después de un bloqueo/gate. La
  primera gate detiene el pass actual de la cola.
- Hacer que Forgium controle, cierre o edite tickets de `pi-spec-flow`.
- Reintentos automáticos sobre un estado durable sin cambio desde la última
  observación.
- Aprobación de una definición humana sin que la persona la confirme.
- Nueva infraestructura remota; `--watch` es un proceso local.
- Identidad criptográfica de implementador/reviewer. La independencia v1 se
  garantiza por adaptadores y sesiones separadas, y por receipts diferenciados.

## 3. Modelo de estados y artefactos

```text
product/inbox (intención cruda)
  ├─ clasificación automática XS/S de bajo riesgo → features/ready/<id>
  └─ decisión humana requerida
       ├─ Spec → features/definition/<id>/spec.md
       └─ ADR  → features/definition/<id>/adr.md
             └─ confirmación humana → features/ready/<id>

features/ready → doing → review → done
                    │       │
                    └─ blocked ←┘
```

`features/definition/<id>/` es una **carpeta de definición**, no un estado de
Work: no contiene un `manifest.yaml` ejecutable, nunca es seleccionable y no
puede mover una Work a `doing`. Reemplaza el uso de Drafts sin reintroducirlos.
Su `definition.yaml` contiene `inboxRef`, `kind`, `created` y la ruta del
documento humano. Al confirmar una definición válida, Forgium crea el
`manifest.yaml` completo y mueve atómicamente la carpeta a `features/ready`.

Toda Work `ready` debe declarar `verification.commands`,
`verification.requiredEvidence`, o ambos; al menos uno no puede estar vacío.

## 4. Clasificación y sizing

Pi devuelve un objeto estructurado; texto libre no puede promover Inbox ni
crear Work. Forgium valida el objeto contra un schema antes de persistirlo.

```ts
type WorkSize = "XS" | "S" | "M" | "L" | "XL";
type Classification = {
  route: "auto_direct" | "ask_direct" | "ask_spec" | "ask_adr" | "split";
  size: WorkSize;
  estimatedTouchedFiles: number;
  complexityScore: number;
  confidence: number; // 0..1
  risks: Array<"public_api" | "persistence" | "security" | "external_integration" | "multi_package" | "unknown_impact">;
  rationale: string[];
  proposed: { title: string; goal: string; acceptance: string[]; verification: VerificationPolicy };
};
```

### 4.1 Sizing obligatorio

| Tamaño | Archivos estimados | Regla |
| --- | ---: | --- |
| XS | 1 | Puede ser auto-direct si no tiene riesgo duro. |
| S | 1–2 | Puede ser auto-direct si no tiene riesgo duro. |
| M | 3–5 | Requiere decisión humana; por defecto Spec. |
| L | 5–8 | Requiere Spec humano. |
| XL | Más de 8 | Inválido como una sola Work/ticket; debe dividirse. |

`complexityScore` se calcula de forma reproducible: base `XS=1`, `S=2`,
`M=3`, `L=4`, `XL=5`; se suman `+2` por API pública, persistencia/migración,
integración externa, multi-paquete o impacto desconocido, y `+3` por
seguridad/autorización. El agente debe informar los factores; Forgium vuelve a
calcular el puntaje y rechaza discrepancias.

Un Inbox se promueve automáticamente solo si se cumplen todas estas reglas:

1. `size` es XS o S;
2. `estimatedTouchedFiles <= 2`;
3. `complexityScore <= 3`;
4. no hay riesgos listados;
5. `confidence >= 0.85`;
6. la Work propuesta tiene contrato y política de verificación válidos.

Cualquier incumplimiento es fail-safe: `run` muestra la propuesta y pide una
decisión. M/L se enrutan a Spec, una decisión arquitectónica/API/persistencia
con alternativas se enruta a ADR y XL genera una propuesta de división; no se
crea una Work XL.

## 5. Definición humana

Cuando el route es `ask_spec`, `ask_adr` o `split`, `run` debe mostrar el
análisis, opciones y recomendación. La persona elige: crear Spec, crear ADR,
dividir, posponer, rechazar o salir. Al elegir Spec/ADR, Forgium crea
`features/definition/<id>/` y un template; la persona escribe el documento en
esa carpeta.

En un `run` posterior (o al detectarlo `--watch`), Forgium valida el documento
contra el contrato mínimo: título, objetivo, criterios de aceptación y política
de verificación. Muestra un resumen y pide confirmación explícita antes de
convertir la carpeta de definición en Work `ready`. No se permite que Pi
confirme una definición humana.

## 6. Implementación, verificación y review

### 6.1 Adaptadores

| Ruta de Work | Implementador | Fuente de verdad para terminar |
| --- | --- | --- |
| `auto_direct`/directa | nueva sesión Pi directa | resultado estructurado del adaptador + verificación Forgium |
| Spec-driven | Pi con `pi-spec-flow` | `spec_flow_status.complete === true` + verificación Forgium |

El adaptador directo recibe título, objetivo, criterios, restricciones,
verificación y paths permitidos; debe devolver `completed`, `blocked`,
`needs_human`, `verification_failed` o `cancelled` estructurados. Nunca puede
mover directorios de Forgium por sí mismo.

El contrato de observación de `pi-spec-flow` no cambia: tickets pendientes,
checkpoint o code review pendiente dejan Work en `doing`; la ausencia de status
estructurado también deja Work en `doing` con receipt `needs_human`.

### 6.2 Verificación

Cuando el implementador termina de forma elegible, Forgium ejecuta comandos de
verificación en orden y registra stdout/stderr, exit code y duración en un
receipt. Evidencia manual pendiente produce `needs_human`; comando fallido
produce `verification_failed` y Work `doing` con handoff. No hay avance a
review sin política satisfecha.

### 6.3 Review de Work independiente

`pi-spec-flow` puede realizar code reviews de sus tickets, pero no sustituye la
review de Work: es parte del loop implementador y no tiene independencia de
sesión. Forgium debe introducir `WorkReviewAdapter`, ejecutado en una sesión Pi
nueva, de solo lectura respecto al estado Forgium.

```ts
type WorkReviewDecision = {
  outcome: "approved" | "changes_requested" | "blocked" | "needs_human";
  summary: string;
  findings: Array<{ severity: "critical" | "major" | "minor"; message: string; reference?: string }>;
  evidence: string[];
};
```

El reviewer recibe el manifiesto, receipts, cambios relevantes y resultados de
verificación. No recibe una instrucción para implementar ni permisos de escribir
`features/`. Forgium persiste un `review` receipt con el adaptador `pi-review`.

- `approved`: `review → done` automáticamente; se cumple la separación entre
  sesión implementadora y revisora.
- `changes_requested`: `review → doing`, persiste handoff y el loop retoma la
  misma Work.
- `blocked` o `needs_human`: se detiene el pass; `blocked` usa el estado
  `blocked`, `needs_human` conserva `review` y explica qué requiere la persona.

La review CLI actual sigue disponible para recuperación manual y debe crear el
mismo tipo de receipt.

## 7. Contrato de `forgium run`

```text
forgium run [--watch] [--non-interactive] [--dry-run] [--json]
```

Sin `--watch`, `run` procesa consecutivamente hasta que no haya Inbox/Work
elegible o encuentre la primera gate, bloqueo, error o señal. Con `--watch`,
permanece activo después de cada pass y ejecuta otro solo tras un cambio durable
relevante o una nueva captura; no sondea/reintenta una Work idéntica.

Orden determinista de cada pass:

1. validar árbol y adquirir lease de loop;
2. renderizar estado;
3. retomar la Work `doing` más antigua, si existe;
4. procesar definición humana pendiente;
5. clasificar Inbox por fecha de creación/ID;
6. tomar la Work `ready` más antigua;
7. implementar, observar, verificar y revisar;
8. persistir receipts y renderizar delta de estado;
9. repetir o detenerse con `stopReason` explícito.

Si hay más de una Work `doing`, es un estado de concurrencia no resuelto:
`run` muestra IDs y detiene con `multiple_active_work`; no elige una. El loop no
inicia una nueva Work mientras otra está `doing` o `review`.

### 7.1 Watch

`--watch` usa `fs.watch` con debounce y un sondeo de respaldo; debe observar
Inbox, definición, manifests, tickets y receipts. Un cambio solo dispara una
nueva pasada si modifica el fingerprint durable de la Work/Inbox correspondiente.
Debe liberar el lease y terminar limpiamente ante SIGINT/SIGTERM.

En modo humano imprime eventos compactos y un estado cuando cambia. En modo
`--json --watch` emite NDJSON: un evento por línea, nunca texto decorativo.

```ts
type RunEvent = {
  at: string;
  type: "status" | "classification" | "transition" | "receipt" | "gate" | "stop";
  workId?: string;
  inboxId?: string;
  state?: string;
  message: string;
  nextAction?: string;
};
```

## 8. Requisitos funcionales

- **FR-1:** `run` MUST ser el único comando que compone producto,
  implementación, verificación y review como un loop completo.
- **FR-2:** MUST mostrar estado inicial, cada transición, cada gate y la acción
  siguiente en modo humano.
- **FR-3:** MUST validar y persistir toda salida de agente que provoque una
  transición; texto libre no es autoridad de estado.
- **FR-4:** MUST usar la política de sizing/riesgo de la sección 4 para decidir
  promoción automática.
- **FR-5:** MUST pedir decisión humana ante routes no automáticos y MUST dejar
  la evidencia durable al salir.
- **FR-6:** MUST seleccionar y procesar una Work por vez hasta idle, gate o
  bloqueo; no puede saltar la Work activa.
- **FR-7:** MUST observar `pi-spec-flow` sin manipular tickets/checkpoints.
- **FR-8:** MUST ejecutar verificación antes de review y MUST impedir `doing → done`.
- **FR-9:** MUST usar un reviewer de sesión/adaptador distinto del implementador
  antes de finalizar automáticamente una Work.
- **FR-10:** `--watch` MUST esperar un cambio durable antes de reintentar y
  MUST ser interrumpible sin corromper estado.
- **FR-11:** los comandos existentes MUST seguir siendo APIs manuales y producir
  receipts/esquemas compatibles con el loop.
- **FR-12:** README y documentación MUST describir `run` como flujo principal.

## 9. Requisitos no funcionales y calidad

- **NFR-1 Determinismo:** toda transición, orden de selección y cálculo de
  complejidad debe ser determinista a igual estado/resultado de agente.
- **NFR-2 Atomicidad:** manifests, receipts, definición y movimientos de
  directorio MUST escribirse atómicamente y validarse antes de persistir.
- **NFR-3 Seguridad:** prompts de Pi MUST delimitar contenido no confiable del
  repositorio y MUST limitar cada adaptador a sus paths/herramientas necesarios.
- **NFR-4 Compatibilidad CLI:** errores usan códigos estables y `--json` no
  mezcla texto humano; watch usa NDJSON.
- **NFR-5 Mantenibilidad:** TypeScript estricto NodeNext, módulos pequeños,
  imports `.js`, sin dependencias de producción nuevas salvo ADR justificado.
- **NFR-6 Observabilidad:** receipts y RunEvent deben permitir reconstruir por
  qué el loop se detuvo sin consultar la conversación del agente.
- **NFR-7 Rendimiento:** una pasada sin invocar Pi no debe hacer polling activo;
  watch debe aplicar debounce y no ejecutar dos passes concurrentes.

## 10. Fases de implementación

1. **Fundación de dominio:** schemas/tipos para sizing, definición, review y
   eventos; repositorio atómico; migración sin Draft.
2. **Clasificación y definición:** adapter Pi de clasificación, política
   determinista, definición humana y promoción validada.
3. **Implementación:** adapter Pi directo, integración de `pi-spec-flow`,
   selección segura y verificación.
4. **Review:** `WorkReviewAdapter`, receipts y transiciones automáticas según
   decisión independiente.
5. **Orquestador:** nuevo `run` hasta idle/gate, estado incremental y JSON.
6. **Watch y endurecimiento:** lease, fingerpints, señales, documentación,
   pruebas reales opt-in y revisión final.

Cada fase debe preservar los checks existentes y no puede cerrar sin sus
criterios de aceptación asociados.

## 11. Criterios de aceptación

### Producto y sizing

- [ ] **AC-1 / FR-4:** dado un Inbox XS sin riesgos, cuando el clasificador
  válido tiene confianza `>= 0.85`, entonces `run` crea exactamente una Work
  `ready` con sizing, razones y verificación persistidos, sin prompt humano.
- [ ] **AC-2 / FR-4:** dado un Inbox S con riesgo, M, L o confianza `< 0.85`,
  cuando `run` lo clasifica, entonces no crea Work ready y muestra una decisión
  humana con propuesta y razones.
- [ ] **AC-3 / FR-4:** dado un Inbox XL, cuando se clasifica, entonces no crea
  una Work XL y solicita una división explícita.
- [ ] **AC-4 / FR-3:** dado un payload de clasificación inválido, entonces no
  cambia Inbox ni Work y termina con evidencia `needs_human`.
- [ ] **AC-5 / FR-5:** dado que la persona elige Spec/ADR, cuando crea el
  documento en `features/definition/<id>/`, entonces el árbol no lo selecciona
  como Work ejecutable.
- [ ] **AC-6 / FR-5:** dada una definición válida confirmada por la persona,
  cuando `run` la procesa, entonces crea una Work ready con manifest y
  verificación válidos mediante transición atómica.

### Implementación, verificación y review

- [ ] **AC-7 / FR-6:** dadas varias Work ready, cuando no hay Work activa,
  `run` selecciona siempre la más antigua con desempate por ID y no inicia una
  segunda hasta terminar/detener la primera.
- [ ] **AC-8 / FR-7:** dado `spec_flow_status.complete !== true`, cuando Pi
  termina, entonces la Work sigue `doing`, recibe handoff y el loop se detiene.
- [ ] **AC-9 / FR-7:** dado `spec_flow_status.complete === true`, cuando los
  comandos de verificación pasan, entonces la Work llega a `review`.
- [ ] **AC-10 / FR-8:** dado un comando de verificación fallido o evidencia
  manual ausente, entonces la Work no llega a review/done y hay receipt con la
  evidencia disponible.
- [ ] **AC-11 / FR-9:** dada una Work en review, cuando el reviewer separado
  aprueba, entonces Forgium escribe receipt de review y la mueve a `done`.
- [ ] **AC-12 / FR-9:** cuando el reviewer pide cambios, entonces Forgium deja
  receipt, mueve a `doing` y retoma esa misma Work antes de cualquier otra.
- [ ] **AC-13 / FR-9:** una sesión/adaptador implementador no puede emitir ni
  persistir una aprobación de Work.

### Loop, watch y recuperación

- [ ] **AC-14 / FR-1:** dado Inbox y Work elegibles, una sola invocación de
  `forgium run` los procesa secuencialmente hasta cola vacía, gate o bloqueo;
  no exige invocar `triage`, `implement` ni `review`.
- [ ] **AC-15 / FR-2:** cada detención humana incluye estado, IDs afectados,
  `stopReason` y una `nextAction` accionable.
- [ ] **AC-16 / FR-6:** dado más de un `doing`, `run` no adivina; termina con
  `multiple_active_work` y enumera los IDs.
- [ ] **AC-17 / FR-10:** dado `run --watch` en idle, no se invoca Pi hasta un
  cambio durable relevante; una captura nueva dispara exactamente un pass.
- [ ] **AC-18 / FR-10:** dado SIGINT/SIGTERM durante watch o una escritura,
  Forgium deja un árbol válido, libera/expira lease correctamente y puede
  reanudarse con otro `run`.
- [ ] **AC-19 / NFR-4:** `forgium --json run --watch` emite solo objetos NDJSON
  válidos y conserva códigos de error estables.

### Calidad, API, documentación y pruebas

- [ ] **AC-20 / NFR-2:** todos los schemas nuevos rechazan artefactos inválidos
  antes de escribirlos; movimientos de definición/Work son atómicos.
- [ ] **AC-21 / NFR-3:** tests cubren payload de repositorio malicioso y
  demuestran que clasificador/reviewer no pueden mover estado Forgium ni
  ejecutar fuera de los paths permitidos.
- [ ] **AC-22 / NFR-5:** `npm run typecheck`, `npm run build`, `npm test` y
  `git diff --check` pasan sin dependencias de producción no justificadas.
- [ ] **AC-23 / NFR-6:** cada ruta de salida de agente y cada gate tiene receipt
  o RunEvent durable suficiente para explicar la reanudación.
- [ ] **AC-24 / FR-12:** README, ayuda CLI y ADRs describen el nuevo contrato;
  no quedan referencias públicas a Draft, comandos Feature obsoletos o a
  `run` como loop solo de producto.
- [ ] **AC-25:** E2E con CLI compilada cubren: auto-XS → implementación directa
  → verificación → review independiente → done; Spec humano → pi-spec-flow
  pendiente → handoff; cambios solicitados → reimplementación; bloqueo;
  selección múltiple; y `--watch` con reanudación.
- [ ] **AC-26:** un E2E real opt-in usa Pi + `pi-spec-flow`; acepta únicamente
  estado estructurado para avanzar y valida que una ausencia de status falla
  cerrada.

## 12. Matriz de pruebas y cierre

| Capa | Cobertura mínima |
| --- | --- |
| Unit | sizing, score, schemas, selección, transiciones, fingerprints, señales |
| Repository | escritura atómica, definición → ready, receipts, validación |
| Adapter | clasificación inválida, Pi directo, Spec Flow completo/pendiente, reviewer |
| CLI | prompts, JSON/NDJSON, stop reasons, recuperación manual |
| E2E compilado | AC-25 completa usando dobles de Pi deterministas |
| E2E Pi opt-in | AC-26 usando Pi/configuración reales |

La implementación termina únicamente cuando todos los AC-1…AC-26 tienen una
prueba trazable, los gates de calidad de AC-22 pasan y un reviewer independiente
no encuentra defectos críticos/major pendientes.

## 13. Riesgos y reglas de parada para el agente implementador

El implementador debe detenerse y pedir aclaración si descubre que el layout de
`features/definition/` contradice un ADR posterior, si necesita un cambio de
API público no descrito, si `pi-spec-flow` no expone un resultado estructurado
consumible o si el contrato de sandbox/permisos de Pi no permite aplicar NFR-3.
No puede sustituir estos casos con parsing de texto libre ni añadir una
dependencia de producción sin actualizar ADR.
