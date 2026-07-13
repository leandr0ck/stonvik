# ADR 0001: Arquitectura de loops de Forgium

**Estado:** Propuesto  
**Fecha:** 2026-07-12  
**Decisores:** Forgium maintainers

## Contexto

Forgium administra trabajo durable dentro de un repositorio: solicitudes crudas
entran al Inbox y las Features avanzan por estados hasta una salida verificable.
El flujo actual expone esos pasos como comandos separados. Eso obliga a la persona
usuaria a recordar cuándo hacer triage, cuándo preparar una Feature y cuándo
ejecutar la siguiente.

El objetivo de Forgium no es solo almacenar una cola. Debe operar una cola de
trabajo de manera repetible, auditable y segura para agentes. Esto requiere que
el sistema, y no una persona en cada turno, decida cuál es el próximo paso a
partir del estado persistido y de evidencia de verificación.

## Decisión

Forgium tendrá un único punto de entrada operativo:

```bash
forgium run
```

`run` ejecutará un **loop de operación del repositorio**. Dentro de él, cada
Feature seleccionada se procesará mediante un **loop de ejecución de Feature**.
Los comandos de bajo nivel (`triage`, `work`, `review`, etc.) se conservarán
para operación manual, automatización y diagnóstico, pero `run` será la
experiencia principal.

### 1. Loop de operación del repositorio

Este loop es responsable del sistema completo y de la planificación entre
Features:

```text
leer estado durable
  → procesar Inbox pendiente
  → crear o completar drafts aprobados
  → promover drafts válidos a ready
  → elegir la siguiente Feature ready
  → ejecutar su loop de Feature
  → registrar el resultado
  → repetir o detenerse
```

El Intake es `product/inbox/`. El loop no debe descartar ni ejecutar una
solicitud cruda sin una transición durable y auditable.

El triage será interactivo por defecto: para cada item, la persona podrá
aprobarlo, editarlo, diferirlo, saltarlo o salir. Una aprobación crea un
**draft** prellenado con el texto de origen. El editor se abrirá únicamente por
confirmación o mediante una opción explícita, respetando `$VISUAL` y luego
`$EDITOR`.

Un draft solo se promueve a `ready` cuando tiene un título, objetivo y al menos
un criterio de aceptación válidos. Por tanto, `ready` mantiene el significado
de “ejecutable”; no es un cajón para requisitos incompletos.

### 2. Loop de ejecución de Feature

Este loop es finito y tiene como unidad de trabajo una sola Feature:

```text
ready
  → doing
  → planificar o seleccionar el motor de ejecución
  → implementar
  → verificar evidencia
  → review
  → done | blocked | doing
```

El loop elegirá una ruta directa o una ruta guiada por especificación según los
artefactos de la Feature. El motor de ejecución puede ser Pi o `pi-spec-flow`,
pero la transición de estado, los límites y el registro de evidencia pertenecen
a Forgium.

Una Feature no se considera completada porque el agente diga que terminó. Debe
pasar las verificaciones definidas por la Feature y la política de review
configurada antes de pasar a `done`.

### 3. Contrato del loop

Todo loop implementado por Forgium debe declarar o heredar este contrato:

| Elemento | Decisión inicial |
| --- | --- |
| Objetivo | Convertir trabajo aprobado en Features con una salida verificable. |
| Trigger | Manual en v1: `forgium run`. Triggers programados son trabajo futuro. |
| Intake | `product/inbox/` y Features persistidas en `features/`. |
| Estado durable | Archivos versionables del repositorio; leases efímeros en `.forgium/runtime/`. |
| Contexto | Manifests, `spec.md`, tickets y reglas del repositorio. |
| Delegación | Un motor de implementación y un reviewer/verificador separados por rol. |
| Verificación | Criterios de aceptación y checks configurados: tests, typecheck, build y validación funcional cuando aplique. |
| Presupuesto | Máximo de Features, reintentos, tiempo y fallos consecutivos. |
| Escalación | Aprobación humana, ambigüedad, bloqueos y agotamiento del presupuesto. |
| Salida | `done`, `blocked`, pausa por presupuesto/interrupción, o ausencia de trabajo. |

### 4. Límites de autonomía

El comportamiento por defecto será acotado:

```bash
forgium run                    # como máximo una Feature ejecutable
forgium run --max-features 3   # como máximo tres Features
forgium run --until-empty      # procesa hasta no encontrar trabajo; sigue pidiendo gates humanos
```

No se implementará un loop infinito o desatendido por defecto. Cada ejecución
debe detenerse además cuando ocurra cualquiera de estas condiciones:

- no hay Inbox accionable ni Features `ready`;
- se alcanza el presupuesto configurado;
- se supera el máximo de reintentos o fallos consecutivos;
- una Feature queda bloqueada;
- falta una aprobación humana;
- la persona usuaria interrumpe el proceso.

Las acciones externas o irreversibles requieren una política explícita y una
aprobación humana; no quedan habilitadas por `run` implícitamente.

### 5. Evidencia y recibos

Cada intento de Feature debe dejar evidencia durable de:

- Feature, motor y run que se ejecutaron;
- comandos de verificación y sus resultados;
- archivos o artefactos relevantes;
- motivo de reintento, bloqueo, escalación o detención.

Los leases de proceso son metadatos locales y efímeros bajo
`.forgium/runtime/`; no sustituyen el estado versionable de Inbox y Features.

## Consecuencias

### Positivas

- Una persona inicia el flujo con un solo comando.
- El trabajo incompleto no se confunde con trabajo listo para ejecutar.
- El estado permite retomar el proceso después de reinicios o cambios de
  sesión.
- Los límites, las aprobaciones y la verificación son responsabilidades del
  loop, no convenciones implícitas del agente.
- El diseño permite añadir triggers, aislamiento y ejecución paralela sin
  cambiar el modelo de estados.

### Costes y restricciones

- Debe incorporarse un estado o representación explícita de draft.
- `run` necesita una interfaz interactiva clara y una ruta no interactiva
  segura para automatización.
- La política de verificación de cada Feature debe definirse antes de permitir
  reintentos autónomos.
- Un reviewer independiente por rol es un objetivo arquitectónico; v1 puede
  empezar con checks deterministas y revisión humana.

## Alternativas consideradas

### Mantener solo comandos manuales

Se descarta como experiencia principal. Es útil para debugging, pero deja la
orquestación y los errores de secuenciación en manos de la persona usuaria.

### Crear Features directamente desde Inbox como `ready`

Se descarta. Un item crudo con frecuencia no contiene objetivo ni criterios de
aceptación verificables. Promoverlo directamente debilita la definición de
`ready` y permite que un agente ejecute trabajo ambiguo.

### Un único loop plano para Inbox, ejecución y review

Se descarta. Mezcla la planificación global con la ejecución de una unidad de
trabajo, vuelve ambiguos los presupuestos y dificulta aislar fallos y
reintentos. Los loops se modelan como niveles distintos, aunque `run` los
orquesta desde un único comando.

### Loop infinito por defecto

Se descarta. Sin un presupuesto, una salida verificable y escalación, un loop
puede repetir fallos y consumir recursos sin control.

## No objetivos de v1

- Triggers programados, webhooks o ejecución cloud persistente.
- Ejecución paralela de múltiples Features.
- Worktrees o sandboxes por Feature.
- Aprobaciones automáticas para acciones externas.
- Un evaluador basado exclusivamente en LLM que pueda autoaprobar su propio
  trabajo.

## Referencias

- [From Prompting Agents to Loop Engineering — Elvis Saravia (X)](https://x.com/omarsar0/status/2068008743153832264)
- [Introducción a Loop Engineering — resumen e interpretación secundaria](https://qiita.com/nogataka/items/60c1a9ba6b2cdebacc1f)
- [Especificación técnica actual de Forgium](../../loop-technical-spec.md)
