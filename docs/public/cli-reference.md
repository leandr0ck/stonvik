# Referencia de CLI

Todos los comandos aceptan las opciones globales:

```text
--root <path>   raíz explícita del repositorio
--json          salida estructurada en stdout y errores estructurados en stderr
```

Sin `--root`, Stonvik descubre la raíz Git o usa el directorio actual si no hay Git.

## Inicialización y consulta

| Comando | Resultado |
| --- | --- |
| `stonvik init` | Crea Inbox, estados de Work, eventos y runtime; agrega `.stonvik/runtime/` a `.gitignore`. |
| `stonvik capture [text...]` | Guarda intención cruda en Inbox. También lee stdin. |
| `stonvik inbox` / `stonvik inbox list` | Lista Inbox items. |
| `stonvik inbox show <inbox-id>` | Muestra una intención. |
| `stonvik inbox answer <inbox-id> <answer...>` | Responde una aclaración pendiente. |
| `stonvik inbox review` | Lista items que requieren atención. |
| `stonvik inbox restore <inbox-id>` | Devuelve un item de review a Inbox. |
| `stonvik status` | Resume Inbox y Work por estado. |
| `stonvik validate` | Valida configuración, schemas, referencias y evidencia. |

## Triage y definición

```text
stonvik triage <inbox-id> --route <direct|spec|adr> --actor <type:name>
stonvik define <inbox-id> --goal <goal> --acceptance <criterion...>
```

Opciones repetibles de `triage`:

- `--risk <risk>`
- `--rationale <text>`

También admite `--size <XS|S|M|L|XL>` y `--touched-files <count>`. El actor puede venir de `--actor` o `STONVIK_ACTOR`; `--role` cambia el rol declarado y por defecto es `triager`.

Opciones de `define`:

- `--title <title>` y `--slug <slug>`;
- `--constraint <text>`;
- `--spec <path>` y `--adr <path>` para registrar documentos existentes; ambas son repetibles;
- `--verify-command <command>`;
- `--manual-evidence <criterion:kind>`.

`define` crea un Work en `features/ready/`. Requiere al menos un comando de verificación o una evidencia manual. Las rutas de spec/ADR deben ser archivos existentes, relativas y fuera de `.stonvik/`, `product/inbox/` y `features/`.

## Implementación externa y gates

```text
stonvik next
stonvik work start <work-id> --actor <type:name> [--run-id <id>]
stonvik work handoff <work-id> --format <json|markdown>
stonvik work report <work-id> --receipt <path> [--run-id <id>]
stonvik verify <work-id>
stonvik work review <work-id> --actor <type:name> --decision <decision>
stonvik ship <work-id>
```

### `work start`

Reclama Work `ready` y lo mueve a `doing`. Crea un claim efímero en `.stonvik/runtime/claims/` y un receipt de ejecución inicial. Un Work `doing` puede reclamarse de nuevo solo después de una recuperación explícita.

### `work report`

Lee un reporte JSON o YAML validado por `ExternalExecutionReport`:

- `completed`: deja el Work en `doing` y habilita `verify`;
- `blocked`: mueve el Work a `blocked` y registra un handoff;
- `needs_human`: deja el Work pendiente y registra un handoff;
- `cancelled`: registra el resultado y una siguiente acción.

Si existe un claim, el actor y, cuando se indica, el `runId` deben coincidir.

### `verify`

Ejecuta desde la raíz del repositorio los comandos de `manifest.yaml`. Un resultado `passed` mueve `doing → review`; cualquier otro resultado deja el Work fuera de `done`.

### `work review` y `ship`

Decisiones válidas: `approved`, `changes_requested`, `blocked` y `needs_human`.

- `approved`: registra aprobación, pero mantiene el Work en `review`;
- `changes_requested`: mueve `review → doing`;
- `blocked`: mueve `review → blocked`;
- `needs_human`: permanece en `review`.

El reviewer debe ser distinto del último implementador y debe existir una verificación actual aprobada. `ship` exige esa aprobación, una ejecución completada y una verificación posterior a la ejecución; entonces mueve `review → done`.

## Operaciones directas de Work

```text
stonvik work create --title <title> --goal <goal> --acceptance <criterion...>
stonvik work show <work-id>
stonvik work list [--state <ready|doing|review|blocked|done>]
stonvik work claim <work-id>
stonvik work recover <work-id> --actor <type:name> [--run-id <id>]
stonvik work unblock <work-id>
```

`work create` acepta las mismas opciones de restricciones, referencias y verificación que `define`. Es la entrada para Work que no proviene de Inbox.

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

- `0`: operación exitosa;
- `2`: contrato, opción, configuración o validación inválida;
- `3`: repositorio no inicializado, Work inexistente, conflicto de estado o claim ocupado;
- `1`: error inesperado.

Los consumidores automatizados deben usar `error.code`, no parsear mensajes humanos.
