# ADR 0003: Contrato de `forgium run`

**Estado:** Propuesto  
**Fecha:** 2026-07-12  
**Decisores:** Forgium maintainers

## Contexto

Los comandos actuales permiten inspeccionar y mover partes de la cola, pero no
ofrecen una operación única que haga triage, prepare trabajo y ejecute la
siguiente Feature. El loop definido en [ADR 0001](0001-loop-architecture.md)
necesita una interfaz de usuario explícita: debe saber cuándo pedir una
decisión, cuándo puede continuar sin ella y cuándo detenerse.

El comando no puede convertir “procesar todo” en autonomía sin límites. Debe
ser seguro en una terminal interactiva, útil desde un script y capaz de dejar
el repositorio en un estado retomable si se interrumpe.

## Decisión

`forgium run` es el comando orquestador del repositorio. Lee el estado durable,
resuelve el trabajo que puede resolver dentro de su presupuesto y devuelve una
salida estructurada que explica qué hizo y por qué se detuvo.

```bash
forgium run
```

Los comandos `triage`, `work`, `review` y las operaciones de Feature se
conservarán como primitivas manuales. `run` las compone; no duplica sus reglas
de estado ni sus validaciones.

## Interfaz

### Opciones iniciales

```text
forgium run [--max-features <n> | --until-empty] [--edit] [--non-interactive]
            [--dry-run] [--json] [--root <path>]
```

| Opción | Semántica |
| --- | --- |
| Sin opción de alcance | Procesa el triage disponible y ejecuta como máximo una Feature elegible. |
| `--max-features <n>` | Ejecuta como máximo `n` Features elegibles. `n` debe ser un entero positivo. |
| `--until-empty` | Repite ciclos hasta que no queda trabajo elegible, se requiere una decisión humana, se agota otro presupuesto o ocurre un error. Es incompatible con `--max-features`. |
| `--edit` | Abre automáticamente el editor configurado al crear o reanudar cada Draft. Sin esta opción, el modo interactivo pregunta antes de abrirlo. |
| `--non-interactive` | Nunca lee prompts ni abre un editor. No aprueba items `captured`; solo puede promover Drafts ya válidos y ejecutar Features `ready`. |
| `--dry-run` | Muestra las acciones y la siguiente decisión sin escribir archivos, iniciar motores ni cambiar estados. |
| `--json` | Emite el resumen y los eventos como JSON; no cambia las reglas de seguridad. |
| `--root <path>` | Selecciona explícitamente el repositorio o directorio administrado. |

La configuración posterior podrá añadir límites de tiempo, coste y reintentos.
Hasta que exista esa política, `run` no reintentará automáticamente una
implementación o una verificación fallida: registrará el resultado y escalará.

### Preflight

Antes de cambiar estado, `run` debe:

1. Resolver la raíz y comprobar que Forgium está inicializado.
2. Validar el árbol de estado, los Inbox items y los Drafts necesarios para la
   iteración.
3. Cargar el presupuesto y determinar si el modo permite interacción.
4. Comprobar que existe un motor de ejecución para la Feature seleccionada
   antes de moverla a `doing`.

Un fallo de preflight no debe crear leases, mover Features ni marcar Inbox items
como procesados.

## Algoritmo de operación

El loop usa el siguiente orden en cada ciclo:

```text
preflight
  → retomar Drafts existentes
  → procesar Inbox captured (si el modo permite interacción)
  → promover Drafts válidos a ready
  → seleccionar la siguiente Feature ready
  → ejecutar el loop de Feature
  → guardar evidencia y resumen
  → decidir repetir o detenerse
```

### 1. Resolver Drafts primero

Los Drafts existentes se presentan antes que los nuevos Inbox items. Esto evita
que `run` cree propuestas nuevas mientras acumula trabajo de definición
incompleto.

En modo interactivo, para cada Draft el usuario puede:

```text
[e]ditar   abrir draft.md en el editor
[p]romover promover si pasa validación
[s]altar   dejarlo sin cambios y continuar
[q]uit      detener el run sin perder estado
```

En modo no interactivo, un Draft válido puede promoverse de manera
determinista. Un Draft incompleto queda sin cambios y se informa como trabajo
que requiere intervención humana.

### 2. Triage del Inbox

Solo el modo interactivo puede decidir sobre un Inbox `captured`:

```text
[a]probar    crear un Draft enlazado al Inbox
[d]iferir    cambiar el Inbox a deferred
[m]ezclar    enlazarlo con una Feature existente (requiere seleccionar destino)
[s]altar     dejarlo captured y continuar
[q]uit       detener el run
```

Después de aprobar, `run` crea el Draft y ofrece editarlo. La aprobación no
crea una Feature `ready`; la promoción posterior sigue las reglas de
[ADR 0002](0002-draft-state-and-artifacts.md).

El triage se repite hasta que no haya Inbox `captured` o la persona elija salir.
Un item saltado no se vuelve a mostrar dentro del mismo run para evitar loops
de interacción sin progreso.

### 3. Selección y ejecución de Feature

Tras el triage, `run` selecciona la Feature `ready` más antigua por fecha de
creación, con desempate por ID. En v1 no hay priorización semántica ni ejecución
en paralelo.

El loop de Feature procede así:

```text
seleccionar ready
  → comprobar motor y presupuesto
  → ready → doing y crear lease efímero
  → pedir al motor que implemente el contrato
  → ejecutar verificaciones configuradas
  → enviar a review o escalar según la política
  → registrar recibo y resultado
```

El adaptador del motor devuelve un resultado explícito, no texto libre:

```text
completed | verification_failed | blocked | needs_human | cancelled
```

La transición final corresponde a Forgium:

| Resultado del adaptador o verificador | Acción de Forgium |
| --- | --- |
| `completed` y verificación aprobada | Mover a `review`; el cierre a `done` requiere la política de review. |
| `verification_failed` | Conservar evidencia y escalar; no reintentar automáticamente en v1. |
| `blocked` o `needs_human` | Mover a `blocked` con un motivo y una referencia de evidencia. |
| `cancelled` o interrupción | Conservar la Feature en `doing`, liberar o expirar el lease y registrar el handoff. |

Una implementación no puede mover una Feature a `done` directamente. Esto
preserva la separación entre producir trabajo y decidir que cumple el contrato.

## Condiciones de parada

`run` se detiene y reporta un motivo explícito cuando:

- no queda Inbox accionable, Draft promovible ni Feature `ready`;
- alcanza `maxFeatures`;
- el usuario elige salir o interrumpe el proceso;
- aparece una decisión humana necesaria en modo no interactivo;
- una Feature se bloquea, falla preflight o falla la verificación;
- no hay motor configurado para la siguiente Feature;
- `--dry-run` ha mostrado la siguiente acción planificada.

`--until-empty` significa “hasta no tener trabajo **elegible**”, no “borrar
toda evidencia ni resolver automáticamente cada Inbox”. Drafts incompletos,
Inbox diferidos y Features bloqueadas permanecen en el repositorio y se
incluyen en el reporte final.

## Interrupción y reanudación

Las transiciones de archivos deben ser atómicas. Al recibir `SIGINT` o `SIGTERM`:

1. no se inicia una nueva unidad de trabajo;
2. se espera a que termine la escritura atómica en curso;
3. se guarda un recibo de handoff con la última acción y evidencia disponible;
4. se libera el lease si es seguro hacerlo, o se deja expirar para diagnóstico;
5. se devuelve un resultado de interrupción no exitoso.

El siguiente `forgium run` vuelve a leer el estado del repositorio; nunca
depende de memoria de proceso para saber qué continuar.

## Salida

La salida humana debe contener, como mínimo:

```text
Forgium run
  Inbox: 2 drafted, 1 deferred
  Drafts: 1 promoted, 1 needs input
  Features: 1 started, 0 completed, 0 blocked
  Stop: max-features reached
```

Con `--json`, se emitirá un objeto que incluya `root`, acciones realizadas,
Features afectadas, verificaciones, elementos que requieren atención y el
`stopReason`. Esto permite que otra herramienta invoque `run` sin interpretar
texto de terminal.

## Consecuencias

### Positivas

- El usuario inicia el flujo de punta a punta con un solo comando.
- El modo no interactivo tiene límites claros y no convierte Intake crudo en
  trabajo aprobado por accidente.
- Las interrupciones dejan un estado retomable y explicable.
- El mismo contrato sirve para una terminal, un futuro scheduler y una
  integración con Pi.

### Costes y restricciones

- Requiere una interfaz de prompts, manejo de señales y un formato de resumen
  más rico que los comandos actuales.
- El adaptador de ejecución debe definirse antes de que `run` pueda implementar
  Features end-to-end.
- La política detallada de receipts, retries y review queda como decisión
  posterior; v1 opera de forma conservadora ante fallos.

## Alternativas consideradas

### Separar el flujo en `triage`, `work` y `review` obligatorios

Se descarta como experiencia principal. Sigue siendo útil como API manual, pero
delega el loop y la secuencia correcta al usuario.

### Aprobar Inbox automáticamente en modo no interactivo

Se descarta. Un Inbox es intención sin confirmar; tratarlo como trabajo
aprobado elimina el gate humano y puede llenar la cola con Features ambiguas.

### Ejecutar todas las Features por defecto

Se descarta. El límite por defecto de una Feature reduce el radio de impacto y
permite revisar el comportamiento del loop antes de escalarlo.

### Reintentar indefinidamente verificaciones fallidas

Se descarta. Sin una política de presupuesto y evidencia, los retries ocultan
problemas y convierten fallos repetidos en coste no controlado.

## No objetivos de v1

- Daemon, cron, webhooks o ejecución cloud persistente.
- Aprobación automática de Inbox mediante LLM.
- Ejecución paralela de Features.
- Reintentos autónomos de implementación.
- Una política final de prioridades, coste o SLA.

## Referencias

- [ADR 0001: Arquitectura de loops de Forgium](0001-loop-architecture.md)
- [ADR 0002: Drafts y artefactos del ciclo de vida](0002-draft-state-and-artifacts.md)
