# Contratos públicos

Los contratos están versionados con `schemaVersion: 1`. Los actores pueden ser implementados en cualquier lenguaje; la CLI es el punto de validación y persistencia común.

## ActorRef

```json
{
  "type": "agent",
  "name": "codex",
  "role": "implementer",
  "version": "2026.09"
}
```

Valores de `type`: `human`, `agent`, `ci` y `process`.

Valores de `role`: `triager`, `implementer`, `specifier`, `verifier`, `reviewer`, `product-owner`.

La identidad es declarativa. `human:lean` y `agent:codex` son procedencia, no credenciales.

## ExternalExecutionReport

Campos obligatorios:

```json
{
  "schemaVersion": 1,
  "actor": {
    "type": "agent",
    "name": "codex",
    "role": "implementer"
  },
  "outcome": "completed",
  "summary": "Resultado resumido del actor.",
  "artifacts": ["src/export.ts"],
  "evidence": [
    {
      "criterion": "La exportación está disponible",
      "kind": "test-output",
      "ref": "artifacts/export-test.txt"
    }
  ],
  "details": {
    "provider": "example",
    "run": "external-run-001"
  }
}
```

`outcome` acepta `completed`, `blocked`, `needs_human` o `cancelled`. `completed` nunca equivale a verificación ni aprobación.

`artifacts` debe contener paths existentes, relativos al repositorio, sin rutas absolutas ni segmentos `..`. Las referencias locales de `evidence` tienen la misma regla; una evidencia puede referenciar una URL externa si el sistema que la produce la necesita.

`details` es metadata opcional. Se recomienda namespacing para que Stonvik no tenga que interpretar campos específicos de una herramienta.

## WorkHandoff

El handoff JSON contiene:

- `work`: ID, tipo, título, objetivo, aceptación, restricciones y referencias;
- `execution`: paths permitidos y política de verificación;
- `protocol`: comandos de reporte y solicitud de review.

El handoff no contiene modelos, prompts ni instrucciones de Pi. Es una vista generada; no modifica el repositorio.

## RoutingDecision

```json
{
  "schemaVersion": 1,
  "inboxId": "inbox-2026-09-13T10:00:00.000Z-abc123",
  "route": "direct",
  "signals": {
    "size": "S",
    "estimatedTouchedFiles": 2,
    "risks": []
  },
  "rationale": ["Cambio acotado a dos archivos."],
  "decidedBy": {
    "type": "human",
    "name": "lean",
    "role": "triager"
  },
  "created": "2026-09-13T10:00:00.000Z"
}
```

La decisión queda asociada al Inbox y al Work. La validación comprueba la forma, la coherencia entre tamaño y archivos, y la política activa.

## Configuración core

La configuración neutral vive en `stonvik.json`:

```json
{
  "routing": {
    "requireSpecWhen": {
      "risks": ["public_api", "security"]
    },
    "direct": {
      "maximumSize": "S",
      "maximumTouchedFiles": 3
    },
    "ambiguity": {
      "requireRole": "product-owner"
    }
  }
}
```

Las claves históricas `pi`, `classification`, `execution` y `review` solo pertenecen a la ruta de compatibilidad del adaptador Pi. Los comandos neutrales del core no las necesitan.

## Persistencia

- `product/inbox/`: intención cruda y decisiones de preparación.
- `features/ready|doing|review|blocked|done/`: directorios completos de Work.
- `receipts/`: receipts append-only asociados a cada Work.
- `product/events/`: streams de eventos durables.
- `.stonvik/runtime/claims/`: claims locales y efímeros.
