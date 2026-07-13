# ADR 0004: Verificación, review y receipts de ejecución

**Estado:** Propuesto  
**Fecha:** 2026-07-12  
**Decisores:** Forgium maintainers

## Contexto

Un loop de agentes solo es fiable si puede demostrar por qué avanzó o se
detuvo. Un mensaje del agente que afirma “terminé” no prueba que se hayan
cumplido los criterios de aceptación, que el build funcione ni que el cambio
sea apto para cerrar.

Forgium ya persiste el estado de una Feature mediante su directorio. Falta
definir qué evidencia guarda cada intento, cómo se evalúan checks, quién puede
aprobar una Feature y qué ocurre cuando falla la verificación. Sin este
contrato, `forgium run` no puede detener reintentos de forma segura ni explicar
un resultado al usuario o a un reviewer posterior.

## Decisión

La ejecución, la verificación y el review producen **receipts durables,
append-only y versionables** dentro del directorio de la Feature. Una Feature
solo puede llegar a `done` después de una decisión de review registrada. Las
afirmaciones del implementador nunca son evidencia suficiente por sí mismas.

```text
features/<state>/<slug>/
├── manifest.yaml
├── draft.md                    # opcional; si procede de un Draft
├── receipts/
│   ├── receipt-...-execution.yaml
│   ├── receipt-...-verification.yaml
│   └── receipt-...-review.yaml
└── …otros artefactos
```

El directorio completo se mueve con la Feature, por lo que sus receipts quedan
junto al contrato y al resultado independientemente de su estado actual.

Los logs extensos de proceso, tokens, streams y datos de depuración no se
versionan. Son efímeros y viven bajo `.forgium/runtime/runs/`, que está en
`.gitignore`.

## 1. Contrato de verificación

### 1.1 Fuentes de verificación

La Feature puede declarar una política de verificación opcional en su manifest:

```yaml
verification:
  commands:
    - name: unit-tests
      run: npm test
    - name: typecheck
      run: npm run typecheck
  requiredEvidence:
    - criterion: The WhatsApp button is visible on the storefront.
      kind: browser-check
  review: required
```

La extensión será compatible con manifests existentes: si falta
`verification`, no se considera que no haya checks; se considera que no existe
una política automática suficiente para cerrar la Feature. En ese caso, la
Feature puede avanzar a `review`, pero el reviewer humano debe decidir qué
evidencia adicional requiere.

Cada `commands[].run` es un comando de shell declarado por el propietario del
repositorio o de la Feature. Forgium no infiere ni genera comandos de
verificación desde la respuesta de un agente.

`requiredEvidence` representa comprobaciones que no se reducen necesariamente
a un exit code: una prueba de navegador, una captura, una respuesta HTTP o una
validación manual. La evidencia se adjunta al receipt de verificación mediante
una ruta relativa, URL permitida o resumen reproducible.

### 1.2 Resultado de verificación

El verificador devuelve un resultado tipado:

```text
passed | failed | manual_required | not_configured | cancelled
```

| Resultado | Regla de transición |
| --- | --- |
| `passed` | La Feature puede avanzar de `doing` a `review`. |
| `failed` | La Feature permanece en `doing`, se escribe un handoff y `run` se detiene; v1 no reintenta automáticamente. |
| `manual_required` | La Feature avanza a `review` con los checks pendientes visibles para el reviewer. |
| `not_configured` | La Feature avanza a `review`, nunca directamente a `done`. |
| `cancelled` | La Feature permanece en `doing`; se guarda evidencia de la interrupción. |

`passed` exige que todos los comandos requeridos terminen con exit code `0` y
que toda evidencia obligatoria esté presente y sea válida según su tipo. No
basta con que el implementador afirme que realizó una comprobación.

### 1.3 Límites de seguridad para checks

- Los comandos se ejecutan desde la raíz del repositorio en v1.
- El receipt registra comando, directorio de trabajo, exit code, duración y
  resumen de salida.
- No se persisten variables de entorno, secretos, tokens, cabeceras de
  autorización ni output que los contenga.
- La salida capturada se limita y se redacta. La ruta a un log efímero puede
  registrarse como dato diagnóstico local, pero no como evidencia durable.
- Un comando que excede el timeout configurado se registra como `failed` o
  `cancelled`, nunca como aprobado por omisión.

## 2. Contrato de review

El review es una decisión separada de la implementación. Quien implementa una
Feature no puede moverla directamente a `done`.

### 2.1 Entrada mínima del reviewer

El reviewer recibe o puede inspeccionar:

- `manifest.yaml` y criterios de aceptación;
- diff o conjunto de archivos cambiados;
- receipts de ejecución y verificación;
- artefactos de evidencia referenciados;
- notas, handoff y motivo de cualquier check pendiente.

El reviewer puede ser una persona, un agente distinto con un rol de evaluación,
o una combinación de checks deterministas y aprobación humana. En v1, el cierre
automático no está permitido: toda Feature en `review` requiere una acción de
review explícita.

### 2.2 Decisiones de review

```text
approved | changes_requested | blocked
```

| Decisión | Transición | Efecto |
| --- | --- | --- |
| `approved` | `review → done` | Registra qué evidencia justifica el cierre. |
| `changes_requested` | `review → doing` | Registra hallazgos accionables; una nueva ejecución crea nuevos receipts. |
| `blocked` | `review → blocked` | Registra impedimento, responsable y siguiente acción esperada. |

Un reviewer automático futuro debe ser independiente del implementador por
rol, modelo o ejecución, y su política debe configurarse explícitamente. No se
permitirá que el mismo resultado del implementador sea su propia aprobación.

## 3. Formato de receipt

Los receipts usan YAML y un esquema versionado. Cada archivo representa un
hecho de una sola fase; se agrega uno nuevo en lugar de sobrescribir el
anterior.

```yaml
schemaVersion: 1
id: receipt-20260712T104500-0300-a8f4-verification
kind: verification
created: 2026-07-12T10:45:00-03:00

feature:
  id: feature-add-whatsapp-button
  manifestPath: manifest.yaml
runId: run-20260712T103000-0300-b7c2

actor:
  type: verifier
  name: forgium
  version: 0.1.0

outcome: passed
summary: All configured checks passed.

checks:
  - name: unit-tests
    command: npm test
    cwd: .
    exitCode: 0
    durationMs: 1842
    status: passed
    outputSummary: 12 tests passed.

evidence:
  - criterion: The WhatsApp button is visible on the storefront.
    kind: browser-check
    status: passed
    ref: artifacts/storefront-button.png
```

Campos comunes obligatorios:

| Campo | Propósito |
| --- | --- |
| `schemaVersion`, `id`, `kind`, `created` | Identificación y evolución del formato. |
| `feature` | Feature y manifest que se evaluaron. |
| `runId` | Correlación con el lease y los logs efímeros, si aplica. |
| `actor` | Rol, herramienta y versión que produjo el receipt. |
| `outcome` y `summary` | Decisión legible y resultado tipado. |

Tipos iniciales de `kind`:

```text
execution | verification | review | handoff
```

Los receipts de `execution` registran motor, intervalo y archivos o artefactos
producidos. Los de `review` registran decisión, hallazgos y referencias a los
receipts evaluados. Los de `handoff` registran una interrupción, fallo o acción
humana pendiente.

Los identificadores se generan con timestamp y sufijo aleatorio. Los archivos
son inmutables tras escribirse; una corrección se representa mediante otro
receipt que referencia al anterior.

## 4. Escritura y validación

Forgium debe:

1. crear el directorio `receipts/` al escribir el primer receipt;
2. validar el receipt antes de persistirlo;
3. escribirlo atómicamente y no sobrescribir un ID existente;
4. validar que los `ref` locales no escapen del directorio de la Feature;
5. incluir errores de esquema, referencias rotas y receipts incompatibles en
   `forgium validate`.

Una referencia a evidencia ausente hace que el receipt de verificación sea
inválido. `forgium run` debe escalar ese fallo en lugar de pasar la Feature a
review como si la evidencia existiera.

## 5. Relación con interrupciones y retries

Este ADR concreta el resultado `verification_failed` de
[ADR 0003](0003-forgium-run-contract.md): la Feature se conserva en `doing`,
con un receipt de verificación fallida y un receipt de handoff. No se reintenta
automáticamente en v1.

Una ejecución posterior puede volver a intentar el trabajo mediante una acción
explícita. Debe crear nuevos receipts, preservando el historial previo. La
política futura de retries deberá declarar, como mínimo, máximo de intentos,
presupuesto de tiempo/coste y qué evidencia de error se entrega al siguiente
implementador.

## Consecuencias

### Positivas

- `done` queda respaldado por evidencia inspeccionable y no por texto del
  agente.
- Se puede reconstruir qué ocurrió entre sesiones sin guardar transcripciones
  completas ni depender de memoria de proceso.
- Los fallos de verificación son visibles, no se convierten en reintentos
  silenciosos.
- La misma estructura admite review humano hoy y evaluadores independientes en
  el futuro.

### Costes y restricciones

- Se añaden esquemas, validación, redacción de output y gestión de artefactos.
- Los equipos deben declarar checks o asumir una revisión humana más estricta.
- Los receipts aumentan el historial versionado; por eso contienen resúmenes y
  referencias, no logs completos.

## Alternativas consideradas

### Guardar solo logs locales de ejecución

Se descarta. Los logs expiran, no viajan con la Feature y no constituyen un
contrato auditable para retomar o revisar el trabajo.

### Marcar `done` cuando todos los tests terminan en verde

Se descarta. Los tests pueden no cubrir criterios de aceptación, flujos reales
o regresiones visuales. Los checks son evidencia importante, no una sustitución
universal de review.

### Permitir autoaprobación del implementador

Se descarta. Mezcla la producción de cambios con el juicio de completitud y
debilita el principal gate de calidad del loop.

### Versionar stdout y stderr completos

Se descarta. Puede filtrar secretos, hacer crecer el repositorio sin límite y
convertir receipts en logs difíciles de leer.

## No objetivos de v1

- Captura, almacenamiento o búsqueda de logs completos.
- Política automática de retries y presupuestos de coste.
- Evaluador LLM autónomo que cierre Features.
- Integración de CI remoto, PRs o sistemas de observabilidad externos.

## Referencias

- [ADR 0001: Arquitectura de loops de Forgium](0001-loop-architecture.md)
- [ADR 0003: Contrato de `forgium run`](0003-forgium-run-contract.md)
