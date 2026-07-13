# ADR 0002: Drafts y artefactos del ciclo de vida

**Estado:** Propuesto  
**Fecha:** 2026-07-12  
**Decisores:** Forgium maintainers

## Contexto

El Inbox contiene intención cruda y de baja fricción. Una Feature `ready`, en
cambio, es un contrato ejecutable: necesita título, objetivo y al menos un
criterio de aceptación. Crear una Feature `ready` directamente desde un Inbox
obliga a inventar esos campos, o a permitir Features inválidas en la cola de
ejecución.

El loop definido en [ADR 0001](0001-loop-architecture.md) requiere un espacio
durable para que la persona usuaria o un agente complete y revise la propuesta
antes de programarla. Ese espacio debe ser editable como Markdown, rastreable
hasta la solicitud de origen y validable sin depender de un LLM.

## Decisión

Se agrega `features/draft/` como área de preparación. Un **Draft no es una
Feature ejecutable** y no se incluye en `FEATURE_STATES`, ni en el selector de
trabajo de `forgium work` o `forgium run`.

```text
product/
└── inbox/

features/
├── draft/       # propuestas incompletas o pendientes de aprobación
├── ready/       # contratos ejecutables
├── doing/
├── review/
├── blocked/
└── done/
```

### 1. Artefacto de Draft

Cada Draft ocupa un directorio con slug estable:

```text
features/draft/<slug>/
└── draft.md
```

`draft.md` es Markdown editable por personas, con frontmatter YAML validable.
Su plantilla inicial debe conservar el texto original del Inbox y ofrecer los
campos que faltan para promover una Feature:

```md
---
schemaVersion: 1
id: draft-add-whatsapp-button
created: 2026-07-12T10:00:00-03:00
source:
  type: inbox
  ref: inbox-20260712T095500-0300-a8f4

title: Add WhatsApp button
goal: ""
acceptance: []
constraints: []
---

# Contexto original

Add a floating WhatsApp button to the storefront so customers can contact the
store directly.

## Notas de definición

<!-- Decisiones, enlaces de investigación y detalles no contractuales. -->
```

Las reglas del esquema de Draft son deliberadamente más permisivas que las del
manifest de Feature:

- `id`, `created`, `source` y `title` son obligatorios;
- `goal` puede estar vacío;
- `acceptance` puede estar vacío;
- `constraints` y el cuerpo Markdown son opcionales.

El formato permite que `forgium triage --edit` abra un solo archivo en `$VISUAL`
o `$EDITOR`, sin exigir que una persona conozca YAML separado del contexto.

### 2. Promoción determinista a `ready`

Un Draft es promovible solo cuando, tras validar el frontmatter:

- `title` no está vacío;
- `goal` no está vacío;
- `acceptance` contiene al menos un criterio no vacío;
- el slug y el ID final no colisionan con una Feature existente.

La promoción no interpreta texto libre ni llama a un modelo. Genera el contrato
ejecutable `manifest.yaml` a partir del frontmatter y mueve el directorio
completo:

```text
features/draft/<slug>/draft.md
       │ validar y generar manifest.yaml
       ▼
features/ready/<slug>/
├── draft.md       # procedencia y contexto de definición
└── manifest.yaml  # contrato ejecutable autoritativo
```

El `manifest.yaml` mantiene el esquema actual de Feature y contiene la
instantánea ejecutable. Tras la promoción, el manifest es la fuente autoritativa
para ejecución; editar `draft.md` no debe modificarlo silenciosamente. Un futuro
comando de edición podrá regenerar el manifest mediante una acción explícita y
validada.

La operación debe usar escrituras atómicas y comprobar el destino antes de
mover el directorio. Si falla, el Draft debe seguir disponible y no debe
aparecer una Feature parcialmente creada en `ready`.

### 3. Procedencia y estados de Inbox

El Inbox conserva su archivo original como registro de procedencia. Se agrega
el estado `drafted` y la referencia `draftRef`:

```yaml
# al crear el Draft
status: drafted
draftRef: draft-add-whatsapp-button

# al promoverlo a Feature ready
status: promoted
draftRef: draft-add-whatsapp-button
featureRef: feature-add-whatsapp-button
```

El conjunto de estados de Inbox será:

```text
captured → drafted → promoted
captured → deferred
captured → merged
```

`drafted` significa que la solicitud tiene una propuesta en
`features/draft/`; no significa que sea ejecutable. `promoted` significa que la
propuesta ya pasó la validación y creó una Feature `ready`. Las operaciones de
merge y defer no eliminan automáticamente el Inbox para preservar auditoría.

### 4. Tipos y validación

Los Drafts tendrán tipos, esquema y APIs propios:

- `Draft` y `DraftFrontmatter`;
- `DraftSchema` para el frontmatter de `draft.md`;
- `listDrafts`, `getDraft`, `createDraftFromInbox` y `promoteDraft` en el
  repositorio;
- validación de `features/draft/` como parte de `forgium validate`.

`FeatureState` conserva únicamente `ready`, `doing`, `review`, `blocked` y
`done`. Esto evita tener un `FeatureManifest` inválido dentro de una lista de
Features o que el planificador seleccione un Draft accidentalmente.

`InboxItem` y su esquema incorporarán `drafted` y `draftRef`. `featureRef` se
mantiene como vínculo desde el Inbox a la Feature promovida.

### 5. Relación con el loop

El loop de repositorio debe priorizar Drafts existentes antes de crear nuevas
propuestas desde Inbox, para no acumular trabajo de definición abandonado:

```text
1. Reanudar o resolver Drafts existentes.
2. Triagear Inbox captured y crear nuevos Drafts aprobados.
3. Promover Drafts válidos a ready.
4. Ejecutar una Feature ready dentro del presupuesto disponible.
```

Un Draft incompleto es una salida válida del loop de triage: se persiste y el
loop solicita información, edita o se detiene. Nunca se envía al subloop de
ejecución.

## Consecuencias

### Positivas

- Separa intención, definición y ejecución sin artefactos inválidos en
  `ready`.
- Hace que el editor sea parte natural del loop, manteniendo una sola fuente
  humana legible para completar el trabajo.
- Conserva trazabilidad Inbox → Draft → Feature.
- La promoción es determinista, por lo que puede verificarse y probarse sin
  invocar un agente.
- Permite retomar propuestas incompletas entre sesiones.

### Costes y restricciones

- Se añade un directorio, esquema, tipo y APIs nuevos.
- El resumen de estado debe reportar Drafts sin tratarlos como Features listas.
- Debe definirse una UX para retomar, diferir o abandonar Drafts; v1 no los
  elimina automáticamente.
- `draft.md` y `manifest.yaml` comparten algunos campos por diseño. El manifest
  gana como contrato de ejecución después de la promoción.

## Alternativas consideradas

### Permitir manifests incompletos en `features/ready/`

Se descarta. Rompe el contrato de `ready`, obliga a ampliar la validación de
Features con excepciones y aumenta el riesgo de que el scheduler ejecute
trabajo indefinido.

### Usar un `manifest.yaml` incompleto dentro de `features/draft/`

Se descarta. Mezcla dos esquemas con reglas incompatibles bajo el mismo nombre
de artefacto y hace ambigua la validez de un manifest.

### Pedir todos los campos en una serie de prompts

Se descarta como única experiencia. Es útil como alternativa accesible, pero
un documento Markdown editable permite completar información extensa, añadir
contexto y retomar el trabajo fuera de la sesión de CLI.

### Crear la Feature directamente desde Inbox con valores inferidos

Se descarta. Una inferencia puede servir como sugerencia dentro del Draft, pero
no debe sustituir la definición verificable necesaria para programar trabajo.

## No objetivos de v1

- Edición bidireccional y automática entre `draft.md` y `manifest.yaml`.
- Múltiples solicitudes de Inbox como fuente de una sola Feature.
- Eliminación o archivado automático de Drafts.
- Priorización automática basada en valor, esfuerzo o impacto.

## Referencias

- [ADR 0001: Arquitectura de loops de Forgium](0001-loop-architecture.md)
- [Especificación técnica actual de Forgium](../../loop-technical-spec.md)
