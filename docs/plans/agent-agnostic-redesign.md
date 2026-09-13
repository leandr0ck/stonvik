# Plan de rediseño agnóstico de Stonvik

**Estado:** Propuesto
**Alcance:** Rediseño del núcleo y de la CLI; las integraciones con agentes quedan fuera del núcleo
**Objetivo principal:** Convertir Stonvik en el sistema de estado, coordinación y evidencia compartido por humanos, agentes y CI
**Estrategia:** Migración incremental sobre el repositorio actual, no reescritura completa

## 1. Resumen ejecutivo

Stonvik dejará de iniciar, dirigir o interpretar sesiones de Pi. Su responsabilidad será administrar trabajo durable dentro de un repositorio:

- capturar intención sin convertirla inmediatamente en trabajo ejecutable;
- preparar Work mediante una ruta directa o una ruta con especificación previa;
- validar manifests, políticas y transiciones;
- seleccionar y reclamar Work;
- producir handoffs neutrales;
- recibir resultados estructurados de actores externos;
- ejecutar verificación determinista;
- registrar review y evidencia;
- indicar la siguiente acción válida.

Los humanos, agentes y sistemas CI serán actores externos que consumen y producen estado mediante la misma CLI y los mismos contratos JSON. Stonvik no necesitará saber cómo trabaja cada actor.

La inversión de control es el cambio arquitectónico central:

```text
Modelo actual

Stonvik ──inicia y dirige──> Pi ──modifica──> repositorio

Modelo objetivo

Humano ───────┐
Agente ───────┼──consulta/reporta──> Stonvik ──valida/persiste──> repositorio
CI ───────────┘
```

## 2. Decisión de producto

### 2.1 Qué es Stonvik

Stonvik es un workflow manager local y repository-native para trabajo de desarrollo. Funciona como:

- fuente de verdad del estado del Work;
- protocolo común entre actores heterogéneos;
- guardián de invariantes y transiciones;
- registro durable de decisiones y evidencia;
- coordinador de selección, claims y recuperación.

### 2.2 Qué no es Stonvik

Stonvik no será:

- un agente;
- un runtime de agentes;
- un gestor de prompts o modelos;
- un planificador semántico autónomo;
- un reemplazo de Jira, Linear o GitHub Issues;
- un proveedor de CI;
- la autoridad semántica que decide si una implementación es correcta.

### 2.3 Tesis de valor

Una Skill explica a un agente cómo participar. Stonvik garantiza, dentro de los límites de un repositorio local, que el estado tenga forma válida y que las transiciones respeten el workflow.

La propuesta solo se justifica si el mismo Work puede pasar de forma comprensible y recuperable entre varios actores y sesiones.

## 3. Principios de diseño

1. **El repositorio es la fuente de verdad.** El historial conversacional nunca es estado durable.
2. **Intent no es Work.** Un Inbox item puede estar incompleto y nunca se ejecuta directamente.
3. **El núcleo no inicia actores.** Los actores consultan y reportan a Stonvik.
4. **La autoridad depende del rol, no de la tecnología.** Un humano, agente o proceso puede cumplir un rol si la política lo permite.
5. **Las decisiones semánticas tienen actor responsable.** Stonvik registra y valida; no simula comprensión donde no puede ser determinista.
6. **Verificación y review son diferentes.** Pasar comandos no equivale a aprobación semántica.
7. **El ejecutor no se autoaprueba.** `done` requiere una decisión de review separada.
8. **Los receipts son append-only.** No se reescribe historia para representar el último estado.
9. **El camino simple debe seguir siendo simple.** Una corrección pequeña no debe exigir una ceremonia desproporcionada.
10. **Las integraciones dependen de Stonvik; Stonvik no depende de ellas.**

## 4. Alcance inicial

### Incluido

- Ruta de preparación `direct`.
- Ruta de preparación `spec-first`.
- Work de tipo `implementation`.
- Work de tipo `specification`.
- Identidad declarada de actores.
- Handoff neutral en JSON y Markdown.
- Receipts externos validados por schema.
- Verificación determinista ejecutada por Stonvik.
- Review explícito por un actor distinto.
- Migración gradual desde el estado actual.
- Uso completo sin Pi instalado.

### No incluido en el primer release

- Autenticación fuerte o criptografía de actores.
- Ejecución remota.
- Dashboard web.
- Integración directa con GitHub Actions.
- Marketplace o sistema dinámico de plugins.
- Planificación semántica automática.
- Creación automática de múltiples Work desde una spec.
- ADR como tercer tipo de Work.
- Priorización por sprints, story points o calendarios.

## 5. Modelo de dominio objetivo

### 5.1 Estados

Se conserva la máquina de estados existente:

```text
ready → doing → review → done
          │         │
          └─────────┴──> blocked

blocked → ready
review  → doing      (changes_requested)
```

Invariantes:

- no existe `doing → done`;
- un Work en `ready` tiene manifest válido;
- un Work en `review` tiene resultado de ejecución y evidencia suficiente para ser revisado;
- `done` requiere un review aprobado;
- `blocked` requiere razón durable;
- los Drafts o definiciones incompletas no son seleccionables.

### 5.2 Tipo de Work

Agregar al manifest un discriminante compatible hacia atrás:

```ts
type WorkKind = "implementation" | "specification";
```

Durante la migración, la ausencia de `kind` se interpreta como `implementation`. Una versión posterior del schema podrá hacerlo obligatorio.

#### `implementation`

Produce cambios en código, configuración, tests u otros artefactos del repositorio.

#### `specification`

Produce un documento que elimina ambigüedad antes de implementar. Su entregable principal es documental y su review semántico es obligatorio.

### 5.3 Ruta de preparación

```ts
type PreparationRoute = "direct" | "spec-first";
```

- `direct`: el Inbox item se convierte en un Work de implementación.
- `spec-first`: el Inbox item se convierte primero en un Work de especificación. Solo una spec aprobada puede originar Work de implementación.

`split` y `decision-first` quedan fuera del primer alcance, aunque los contratos no deben impedir agregarlos después.

### 5.4 Actor

```ts
interface ActorRef {
  type: "human" | "agent" | "ci" | "process";
  name: string;
  role?: "triager" | "implementer" | "specifier" | "verifier" | "reviewer" | "product-owner";
  version?: string;
}
```

En la primera versión, esta identidad es **procedencia declarada**, no autenticación. Stonvik puede prevenir errores accidentales, pero no demostrar que una persona no falsificó `name`.

### 5.5 Decisión de routing

```ts
interface RoutingDecision {
  schemaVersion: 1;
  inboxId: string;
  route: "direct" | "spec-first";
  signals: {
    size?: "XS" | "S" | "M" | "L" | "XL";
    estimatedTouchedFiles?: number;
    risks: string[];
  };
  rationale: string[];
  proposedBy?: ActorRef;
  decidedBy: ActorRef;
  created: string;
}
```

Responsabilidades:

- un triager humano o agente puede proponer;
- una política determinista limita las rutas permitidas;
- un actor autorizado confirma una excepción o una zona ambigua;
- Stonvik persiste la decisión y aplica la política.

### 5.6 Handoff

```ts
interface WorkHandoff {
  schemaVersion: 1;
  generated: string;
  work: {
    id: string;
    kind: WorkKind;
    title: string;
    goal: string;
    acceptance: string[];
    constraints: string[];
    source?: { type: string; ref: string };
    specificationRef?: string;
  };
  execution: {
    allowedPaths?: string[];
    verification: VerificationPolicy;
  };
  protocol: {
    reportCommand: string;
    requestReviewCommand: string;
  };
}
```

El handoff no contiene nombres de modelos, prompts de Pi ni instrucciones de una herramienta particular.

### 5.7 Resultado de ejecución

Se conserva el receipt de ejecución existente, pero `engine` deja de ser el identificador principal. El actor y el protocolo son la fuente neutral de procedencia.

```ts
interface ExternalExecutionReport {
  schemaVersion: 1;
  actor: ActorRef;
  outcome: "completed" | "blocked" | "needs_human" | "cancelled";
  summary: string;
  artifacts?: string[];
  evidence?: Array<{
    criterion: string;
    kind: string;
    ref?: string;
  }>;
  details?: Record<string, unknown>;
}
```

Un `outcome: completed` es una declaración del ejecutor; no equivale a verificación ni aprobación.

## 6. Políticas de routing

### 6.1 Autoridad

La decisión se divide en tres pasos:

1. un actor propone la ruta;
2. Stonvik evalúa políticas deterministas;
3. un actor con autoridad confirma cuando la política lo exige.

### 6.2 Política inicial sugerida

```yaml
routing:
  requireSpecWhen:
    risks:
      - public_api
      - persistence
      - security
      - external_integration
      - multi_package

  direct:
    maximumSize: S
    maximumTouchedFiles: 3

  ambiguity:
    requireRole: product-owner
```

Esta política debe ser configurable, pero el MVP puede comenzar con valores internos documentados antes de ampliar `stonvik.json`.

### 6.3 Limitación explícita

Stonvik no puede detectar de forma perfecta riesgos semánticos. Puede validar:

- forma del routing;
- coherencia entre size, número de archivos y score;
- riesgos declarados;
- hechos observables del repositorio;
- autorización configurada.

No puede garantizar que el actor declaró todos los riesgos. La responsabilidad queda registrada en `decidedBy`.

## 7. Flujos de usuario

### 7.1 Captura

Terminal:

```bash
stonvik capture "Agregar exportación CSV" --source human:terminal
```

Agente:

```bash
stonvik capture "Agregar exportación CSV" --source agent:pi
```

Ambos producen el mismo Inbox durable; solo cambia la procedencia.

### 7.2 Ruta directa

```bash
stonvik prepare inbox-123 \
  --route direct \
  --actor human:lean

stonvik next
stonvik work start feature-export-csv --actor agent:codex
stonvik handoff feature-export-csv --format json
stonvik work report feature-export-csv --receipt result.json
stonvik verify feature-export-csv
stonvik work review feature-export-csv \
  --actor human:reviewer \
  --decision approved
```

Resultado esperado:

```text
Inbox → ready → doing → review → done
```

### 7.3 Ruta spec-first

```bash
stonvik prepare inbox-123 \
  --route spec-first \
  --actor human:lean
```

Stonvik crea un Work `specification` cuyo entregable es, inicialmente, `spec.md` dentro del directorio completo del Work.

```bash
stonvik work start feature-export-csv-spec --actor agent:claude
stonvik handoff feature-export-csv-spec --format markdown
stonvik work report feature-export-csv-spec --receipt spec-result.json
stonvik verify feature-export-csv-spec
stonvik work review feature-export-csv-spec \
  --actor human:product-owner \
  --decision approved
```

Después de aprobar la spec:

```bash
stonvik work create-from-spec feature-export-csv-spec
```

Stonvik crea un Work `implementation` con una referencia estable al Work de especificación. No inicia ningún ejecutor.

### 7.4 Ejecución mediante CI o scripts

Un proceso puede usar el mismo contrato:

```bash
stonvik next --json
stonvik work start feature-id --actor process:local-runner
stonvik handoff feature-id --format json
stonvik work report feature-id --receipt result.json
```

La integración es responsable de traducir el handoff a su mecanismo de ejecución.

## 8. Arquitectura objetivo

```text
src/
├── core/
│   ├── domain/          # Tipos neutrales
│   ├── schemas/         # Validación de estado y contratos
│   ├── transitions/     # Máquina de estados
│   ├── repository/      # Persistencia atómica y consultas
│   ├── services/        # Casos de uso de gestión
│   └── verification/    # Ejecución determinista de comandos
└── cli/                 # Interfaz humana y JSON

integrations/            # Opcional; puede vivir fuera del paquete principal
├── pi/
├── codex/
└── examples/
```

Regla de dependencias:

```text
integrations → CLI/contratos de Stonvik → core

core -X-> Pi
core -X-> Spec Flow
core -X-> SDK de agentes
```

Inicialmente no se necesita un cargador de plugins. Una integración puede ser un proceso separado que invoque la CLI.

## 9. Estrategia de migración

### 9.1 Evitar una reescritura

Se reutilizan:

- `FilesystemStonvikRepository`;
- `ManifestSchema`;
- receipts existentes;
- `VerificationPolicy`;
- reglas de transición;
- escritura atómica;
- event sink;
- detección de raíz;
- salida JSON de CLI.

### 9.2 Compatibilidad de manifests

1. Agregar `kind` como opcional con default lógico `implementation`.
2. Leer manifests antiguos sin reescribirlos.
3. Escribir `kind` en manifests nuevos.
4. Añadir una migración explícita solo si una futura versión lo vuelve obligatorio.

### 9.3 Compatibilidad de receipts

- Los receipts Pi existentes siguen siendo receipts de ejecución válidos.
- `engine` se conserva como metadata opcional.
- Los receipts nuevos priorizan `actor`.
- No se reescribe evidencia histórica.

### 9.4 Compatibilidad de CLI

Durante una ventana de transición:

- `run` y `implement --engine pi-spec-flow` pueden seguir existiendo con advertencia;
- sus implementaciones se mueven fuera del core;
- los nuevos comandos manuales son la interfaz recomendada;
- la eliminación definitiva requiere una decisión de versión y migración separada.

## 10. Plan de implementación

Cada tarea debe completarse con tests focalizados antes de avanzar. Los checkpoints validan comportamiento integrado, no solo tipos.

### Fase 0 — Contrato y baseline

#### Tarea 0.1 — Caracterizar el comportamiento actual

**Descripción:** Crear o ajustar tests que documenten las invariantes reutilizables antes de mover responsabilidades.

**Aceptación:**

- [ ] Existe cobertura para `ready → doing → review → done`.
- [ ] Existe cobertura que rechaza `doing → done`.
- [ ] Existe cobertura para verificación y receipts.
- [ ] Existe cobertura para recuperación de Work activo.
- [ ] Los tests no requieren Pi real.

**Verificación:**

```bash
npm test
npm run typecheck
```

**Dependencias:** Ninguna.

#### Tarea 0.2 — Registrar la decisión arquitectónica

**Descripción:** Crear un ADR que establezca la inversión de control y la prohibición de dependencias de agentes dentro del core.

**Aceptación:**

- [ ] El ADR define contexto, decisión, consecuencias y alternativas rechazadas.
- [ ] El ADR distingue actor externo de adapter interno.
- [ ] El ADR documenta que identidad declarada no es autenticación.

**Dependencias:** Ninguna.

### Checkpoint 0

- La suite actual está verde.
- El nuevo boundary está documentado.
- No se ha cambiado todavía el comportamiento público.

### Fase 1 — Contratos neutrales

#### Tarea 1.1 — Introducir `WorkKind` de forma compatible

**Descripción:** Agregar `implementation | specification` al dominio y schema sin invalidar manifests existentes.

**Aceptación:**

- [ ] Manifests existentes se leen como `implementation`.
- [ ] Manifests nuevos persisten `kind` explícito.
- [ ] Valores desconocidos se rechazan.
- [ ] No cambia la máquina de estados.

**Archivos probables:**

- `src/core/domain/types.ts`
- `src/core/schemas/manifest.schema.ts`
- tests de schemas y repositorio

**Dependencias:** Fase 0.

#### Tarea 1.2 — Agregar `ActorRef` y routing decision

**Descripción:** Formalizar actores y decisiones de ruta mediante tipos y schemas versionados.

**Aceptación:**

- [ ] Se validan tipos, nombres y roles permitidos.
- [ ] Una decisión contiene `decidedBy` y rationale.
- [ ] La validación semántica rechaza una ruta directa incompatible con la política.
- [ ] La decisión queda asociada al Inbox item o al Work creado.

**Dependencias:** Tarea 1.1.

#### Tarea 1.3 — Agregar `WorkHandoff` y reporte externo

**Descripción:** Definir contratos neutrales de salida y entrada para ejecutores externos.

**Aceptación:**

- [ ] El handoff no menciona Pi, Spec Flow ni modelos.
- [ ] El reporte distingue resultado declarado de verificación.
- [ ] Los paths de artefactos se validan como paths del repositorio.
- [ ] Ambos contratos tienen salida JSON estable.

**Dependencias:** Tarea 1.1.

### Checkpoint 1

- Los contratos pueden serializarse y validarse sin adaptadores.
- Los manifests antiguos siguen funcionando.
- Ningún cambio obliga todavía a migrar estado durable.

### Fase 2 — Lifecycle manual directo

#### Tarea 2.1 — Servicio de preparación directa

**Descripción:** Convertir un Inbox item confirmado en Work `implementation` aplicando routing y validación semántica.

**Aceptación:**

- [ ] Un Inbox incompleto no llega a `ready`.
- [ ] Una política puede obligar a usar spec.
- [ ] La decisión de routing queda durable.
- [ ] La operación es atómica.

**Dependencias:** Fase 1.

#### Tarea 2.2 — Selección y claim neutral

**Descripción:** Exponer selección de Work y comienzo de ejecución sin construir un adapter.

**Aceptación:**

- [ ] `next` devuelve el Work seleccionable más antiguo según las reglas actuales.
- [ ] `work start` registra actor y mueve `ready → doing`.
- [ ] Un segundo claim incompatible se rechaza.
- [ ] Un proceso interrumpido puede inspeccionarse y recuperarse.

**Dependencias:** Tarea 2.1.

#### Tarea 2.3 — Generación de handoff

**Descripción:** Producir contexto JSON y Markdown para el Work activo.

**Aceptación:**

- [ ] Incluye objetivo, aceptación, restricciones, verificación y referencias.
- [ ] No contiene prompts específicos de agente.
- [ ] JSON y Markdown representan el mismo contrato.
- [ ] La generación no modifica estado durable.

**Dependencias:** Tarea 2.2.

#### Tarea 2.4 — Importación de resultados externos

**Descripción:** Registrar un reporte externo como receipt de ejecución y decidir la transición permitida.

**Aceptación:**

- [ ] El reporte se valida antes de persistir.
- [ ] `completed` no produce `done`.
- [ ] Un resultado completado permite iniciar verificación.
- [ ] `blocked`, `needs_human` y `cancelled` tienen comportamiento explícito.
- [ ] No se permite al actor escribir directamente estado interno mediante el reporte.

**Dependencias:** Tarea 2.3.

#### Tarea 2.5 — Verificación y review manual

**Descripción:** Reutilizar verificación determinista y review explícito para cerrar el lifecycle.

**Aceptación:**

- [ ] Stonvik ejecuta los comandos configurados y crea un verification receipt.
- [ ] Fallos de verificación impiden aprobación.
- [ ] El reviewer debe diferir del implementador declarado.
- [ ] Solo `review → done` con decisión aprobada.

**Dependencias:** Tarea 2.4.

### Checkpoint 2 — Milestone directo

Debe funcionar sin Pi instalado:

```text
capture → prepare direct → next → start → handoff
→ report → verify → review → done
```

Verificación requerida:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

### Fase 3 — Lifecycle spec-first

#### Tarea 3.1 — Crear Specification Work

**Descripción:** Permitir que `prepare --route spec-first` produzca un Work documental válido.

**Aceptación:**

- [ ] El Work tiene `kind: specification`.
- [ ] Declara un deliverable documental esperado.
- [ ] Tiene criterios de aceptación propios de la definición.
- [ ] Exige review.

**Dependencias:** Checkpoint 2.

#### Tarea 3.2 — Validar entregable de especificación

**Descripción:** Añadir verificación estructural mínima para specs sin fingir evaluación semántica automática.

**Aceptación:**

- [ ] Se valida existencia y ubicación del documento.
- [ ] Se valida una estructura mínima acordada.
- [ ] La aprobación semántica sigue siendo review explícito.
- [ ] Una spec incompleta no pasa a `done`.

**Dependencias:** Tarea 3.1.

#### Tarea 3.3 — Crear implementación desde spec aprobada

**Descripción:** Crear un Work de implementación enlazado a una Specification Work aprobada.

**Aceptación:**

- [ ] Solo una spec en `done` con review aprobado puede utilizarse.
- [ ] La relación usa una referencia estable, no una ruta dependiente del estado.
- [ ] La spec no se copia ni duplica innecesariamente.
- [ ] El Work creado vuelve a entrar por `ready`.
- [ ] La operación no inicia ningún ejecutor.

**Dependencias:** Tarea 3.2.

### Checkpoint 3 — Milestone spec-first

Debe funcionar:

```text
capture → prepare spec-first
→ specification ready → doing → review → done
→ create-from-spec
→ implementation ready → doing → review → done
```

### Fase 4 — Desacoplar agentes del core

#### Tarea 4.1 — Extraer construcción de Pi desde `AgentLoop`

**Descripción:** Eliminar defaults que instancian clasificación, ejecución o review Pi dentro de servicios centrales.

**Aceptación:**

- [ ] Ningún servicio del core construye `PiClassificationAdapter`.
- [ ] Ningún servicio del core construye `PiRpcExecutionAdapter`.
- [ ] Ningún servicio del core construye `SpecFlowExecutionAdapter`.
- [ ] Ningún servicio del core construye `PiWorkReviewAdapter`.
- [ ] El lifecycle manual sigue funcionando.

**Dependencias:** Checkpoint 3.

#### Tarea 4.2 — Separar configuración específica de Pi

**Descripción:** Mover `pi.command` y modelos fuera de la configuración del núcleo.

**Aceptación:**

- [ ] Core puede cargar configuración sin campos de agentes.
- [ ] `STONVIK_PI_COMMAND` no es leído desde core.
- [ ] Configuración histórica tiene una estrategia de compatibilidad documentada.

**Dependencias:** Tarea 4.1.

#### Tarea 4.3 — Convertir ejecución Pi en consumidor externo

**Descripción:** Adaptar la integración existente para usar `next`, `handoff` y `report`, sin acceso privilegiado al repositorio de estado.

**Aceptación:**

- [ ] La integración Pi depende del contrato público.
- [ ] Core no importa la integración.
- [ ] La integración no mueve directorios de estado directamente.
- [ ] La ausencia de Pi no afecta comandos de gestión.

**Dependencias:** Tareas 4.1 y 4.2.

### Checkpoint 4 — Boundary agnóstico

- Una búsqueda de imports y símbolos Pi en el core no devuelve dependencias operativas.
- Todos los tests del lifecycle manual pasan sin Pi.
- La integración Pi puede probarse por separado.

### Fase 5 — CLI, migración y documentación operativa

#### Tarea 5.1 — Estabilizar CLI y JSON

**Descripción:** Revisar nombres, errores, exit codes y salida JSON de los nuevos comandos.

**Aceptación:**

- [ ] Todos los comandos tienen `--json` cuando corresponde.
- [ ] Los errores tienen códigos estables.
- [ ] La salida humana es concisa.
- [ ] Scripts no necesitan parsear texto humano.

**Dependencias:** Checkpoint 4.

#### Tarea 5.2 — Migración del workflow autónomo

**Descripción:** Definir deprecación o eliminación de `run`, `triage` autónomo e `implement --engine`.

**Aceptación:**

- [ ] Usuarios reciben una ruta de migración.
- [ ] Estado histórico sigue siendo válido.
- [ ] No se borran receipts.
- [ ] Cualquier cambio incompatible tiene decisión de versión explícita.

**Dependencias:** Tarea 5.1.

#### Tarea 5.3 — Ejemplos para humano, agente y CI

**Descripción:** Crear ejemplos mínimos del mismo workflow desde tres tipos de actor.

**Aceptación:**

- [ ] Ejemplo manual desde terminal.
- [ ] Ejemplo de Skill que solo invoca la CLI.
- [ ] Ejemplo de CI que verifica o importa evidencia sin modificar estado ad hoc.
- [ ] Todos usan el mismo schema.

**Dependencias:** Tarea 5.1.

## 11. Estrategia de pruebas

### Unitarias

- schemas de actor, routing, handoff y reportes;
- reglas semánticas de routing;
- transiciones;
- comparación entre implementador y reviewer;
- compatibilidad de manifests antiguos.

### Integración de repositorio

- persistencia atómica;
- movimiento completo del directorio del Work;
- receipts append-only;
- referencias estables entre spec e implementación;
- claims y recuperación.

### Contrato CLI

- salida JSON;
- exit codes;
- stdin y argumentos;
- mensajes de siguiente acción;
- comportamiento sin Pi en `PATH`.

### E2E

1. Lifecycle directo con tres actores declarados.
2. Lifecycle spec-first completo.
3. Verificación fallida y retorno a `doing`.
4. Work bloqueado y posterior reanudación.
5. Intento de autoaprobación rechazado.
6. Interrupción después de `start` y recuperación desde otra sesión.

### Release gate

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

## 12. Riesgos y mitigaciones

### Burocracia para cambios pequeños

**Riesgo:** El workflow cuesta más que el cambio.

**Mitigación:** Mantener una ruta directa corta, defaults razonables y comandos combinables sin relajar invariantes.

### Specs ceremoniales

**Riesgo:** La spec repite el manifest o queda obsoleta.

**Mitigación:** Exigirla solo cuando resuelve ambigüedad o riesgo real. El manifest sigue siendo suficiente para cambios pequeños.

### Falsa seguridad de identidad

**Riesgo:** `--actor` puede falsificarse.

**Mitigación:** Tratarlo como procedencia declarada; reservar receipts firmados para una etapa posterior.

### Conflictos Git

**Riesgo:** Varios actores modifican archivos centrales de estado.

**Mitigación:** Un archivo por Work/receipt, logs particionados, estado agregado derivado y leases efímeros fuera de Git.

### Contrato demasiado genérico

**Riesgo:** El mínimo común entre herramientas pierde información útil.

**Mitigación:** Contrato obligatorio pequeño y metadata opcional namespaced que el core no interpreta.

### Resultados no confiables

**Riesgo:** Un ejecutor declara `completed` sin cumplir criterios.

**Mitigación:** Separar execution receipt, verification receipt y review receipt. Ninguno reemplaza a los otros.

### Scope creep hacia project management

**Riesgo:** Agregar sprints, dashboards, estimaciones y usuarios.

**Mitigación:** Limitar Stonvik a Work que produce artefactos versionables dentro de un repositorio.

### Migración accidentalmente destructiva

**Riesgo:** El rediseño invalida estado previo.

**Mitigación:** Lectura compatible, migraciones explícitas, nunca reescribir receipts y tests con fixtures históricos.

## 13. Preguntas abiertas

Estas decisiones deben resolverse antes de estabilizar el contrato público:

1. ¿El actor se configura por comando, variable de entorno o archivo local?
2. ¿Dónde se persiste exactamente la routing decision: Inbox, receipt o Work?
3. ¿El claim durable pertenece al repositorio o debe permanecer siempre en `.stonvik/runtime/`?
4. ¿Cómo se recupera un Work cuyo actor desapareció después de `start`?
5. ¿Qué estructura mínima debe tener una spec para pasar validación estructural?
6. ¿`create-from-spec` crea un solo Work o solo prepara una definición editable?
7. ¿Cómo importa Stonvik evidencia producida por CI sin exigir commits automáticos?
8. ¿Se mantienen temporalmente `run` y `triage`, o el rediseño será una versión mayor?
9. ¿El nombre público seguirá siendo `Work` mientras el tipo interno continúe llamándose `Feature` durante la migración?

## 14. Decisiones recomendadas para el MVP

Para evitar bloquear el inicio:

- identidad mediante `--actor` y/o `STONVIK_ACTOR`, tratada como declarativa;
- routing decision como receipt durable asociado al Inbox y copiado por referencia al Work;
- claims locales en `.stonvik/runtime/`, con receipt durable de inicio y recuperación explícita;
- spec mínima con problema, alcance, aceptación, restricciones y verificación;
- `create-from-spec` produce una definición editable antes de crear `ready`;
- CI produce evidencia importable; no hace commits de estado automáticamente;
- `run` queda deprecado durante una versión antes de retirarse;
- se conserva `Feature` internamente al principio para evitar un rename masivo sin valor funcional.

## 15. Criterio de éxito del rediseño

El rediseño se considera validado cuando puede demostrarse lo siguiente sin Pi instalado:

```text
1. Un humano captura una intención.
2. Un triager decide y registra direct o spec-first.
3. Un agente externo consume un handoff neutral.
4. El agente reporta mediante un receipt validado.
5. Stonvik o CI ejecuta verificación determinista.
6. Otro actor registra el review.
7. Stonvik reconstruye el estado y explica la siguiente acción
   desde los archivos del repositorio, sin depender de conversaciones.
```

La prueba definitiva no es soportar muchos agentes. Es que cambiar de humano a agente, de agente a CI o de una sesión a otra no cambie el workflow ni destruya su contexto durable.
