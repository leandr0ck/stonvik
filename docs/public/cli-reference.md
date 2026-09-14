# Referencia de CLI

Todos los comandos aceptan las opciones globales:

```text
--root <path>   raíz explícita del repositorio
--json          salida estructurada en stdout y errores estructurados en stderr
```

Cuando no se pasa `--root`, Stonvik intenta descubrir la raíz Git desde el directorio actual y, si no hay Git, usa el directorio actual.

## Inicialización y consulta

| Comando | Resultado |
| --- | --- |
| `stonvik init` | Crea la estructura de Stonvik y protege `.stonvik/runtime/` en `.gitignore`. |
| `stonvik capture [text...]` | Crea un Inbox item. También puede leer texto desde stdin. |
| `stonvik inbox` | Lista Inbox items y su estado. `stonvik inbox list` es un alias explícito. |
| `stonvik next` | Devuelve el Work `ready` más antiguo, sin reclamarlo. |
| `stonvik status` | Resume Inbox y Work por estado. |
| `stonvik validate` | Valida configuración core, Inbox, manifests, receipts, provenance y referencias. |

## Preparación y handoff

```text
stonvik prepare <inbox-id> --route <direct|spec-first> --actor <type:name>
stonvik handoff <work-id> --format <json|markdown>
```

Opciones de `prepare`:

- `--actor <type:name>`: actor que decide la ruta; también se puede usar `STONVIK_ACTOR`.
- `--role <role>`: `triager`, `implementer`, `specifier`, `verifier`, `reviewer` o `product-owner`.
- `--size <XS|S|M|L|XL>`: señal declarada.
- `--touched-files <count>`: cantidad estimada de archivos.
- `--risk <risk>`: riesgo declarado; se puede repetir.
- `--rationale <text>`: justificación; se puede repetir.

La política inicial limita Work directo a `S` y hasta tres archivos, y exige spec-first para riesgos como `public_api`, `persistence`, `security`, `external_integration` y `multi_package`. La excepción corresponde al rol configurado, por defecto `product-owner`, y queda en `decidedBy` y `rationale`.

## Ciclo de ejecución externo

```text
stonvik work start <work-id> --actor <type:name> [--run-id <id>]
stonvik work claim <work-id>
stonvik handoff <work-id> --format json
stonvik work report <work-id> --receipt <path> [--run-id <id>]
stonvik verify <work-id>
stonvik work review <work-id> --actor <type:name> --decision <decision>
```

### `work start`

Acepta Work `ready` o Work `doing` sin claim. Crea un claim en `.stonvik/runtime/claims/`, registra un receipt de inicio y mueve `ready → doing`.

### `work claim`

Solo inspecciona el claim actual. No lo crea ni lo libera.

### `work recover`

```text
stonvik work recover <work-id> --actor <type:name> [--run-id <id>]
```

Recupera un Work `doing` cuando el proceso del claim anterior ya no existe. No se debe borrar el archivo de claim manualmente.

### `work report`

Lee JSON o YAML, valida el contrato y registra un receipt de ejecución:

- `completed`: permanece en `doing`; permite `verify`.
- `blocked`: mueve el Work a `blocked` y crea un handoff durable.
- `needs_human`: permanece pendiente y crea un handoff durable.
- `cancelled`: registra el resultado y la siguiente acción para recuperar o reiniciar.

Si existe un claim, el actor del reporte debe coincidir con el actor reclamante.

### `verify`

Ejecuta los comandos de verificación desde la raíz del repositorio. Un resultado `passed` mueve `doing → review`; cualquier otro resultado deja el Work fuera de `done`.

### `work review`

Decisiones válidas: `approved`, `changes_requested`, `blocked` y `needs_human`.

- `approved`: `review → done`.
- `changes_requested`: `review → doing`.
- `blocked`: `review → blocked`.
- `needs_human`: permanece en `review`.

El reviewer debe ser distinto del actor del último reporte de ejecución y debe existir una verificación actual aprobada.

## Creación manual

```text
stonvik work create \
  --title <title> \
  --goal <goal> \
  --acceptance <criterion...> \
  --verify-command <command>
```

También admite `--constraint`, `--manual-evidence`, `--slug` y `--kind`. Un Work `specification` exige `--spec-file` y un gate de review; la CLI configura ese gate automáticamente.

```text
stonvik work create-from-spec <spec-work-id>
stonvik work unblock <work-id>
stonvik work list [--state <ready|doing|review|blocked|done>]
```

## Errores y exit codes

Con `--json`, un error de dominio tiene esta forma en `stderr`:

```json
{
  "error": {
    "code": "WORK_CLAIM_CONFLICT",
    "message": "..."
  }
}
```

- `0`: operación exitosa.
- `2`: contrato, opción, configuración o validación inválida.
- `3`: repositorio no inicializado, Work inexistente, conflicto de estado, claim ocupado u otro conflicto recuperable.
- `1`: error inesperado no clasificado.

Los consumidores automatizados deben usar `code`, no parsear mensajes humanos.

## Rutas de compatibilidad

`run`, `triage`, `implement --engine pi-spec-flow`, `review` y `work-review` se mantienen para migración. Las integraciones nuevas deben usar el ciclo neutral.
