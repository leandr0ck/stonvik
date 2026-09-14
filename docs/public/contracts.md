# Contratos públicos

Los contratos están versionados con `schemaVersion: 1`. Los actores pueden estar implementados en cualquier lenguaje; la CLI es el punto común de validación y persistencia.

## Manifest de Work

Cada Work ejecutable tiene un `manifest.yaml` dentro de su directorio:

```yaml
schemaVersion: 1
id: feature-export-csv
title: Agregar exportación CSV
created: 2026-09-13T10:00:00.000Z
goal: Permitir exportar los datos visibles a CSV
acceptance:
  - El usuario puede descargar un CSV
verification:
  commands:
    - name: tests
      run: npm test
  requiredEvidence: []
definitions:
  - kind: spec
    path: docs/product/export-csv.md
  - kind: adr
    path: architecture/export-csv.md
```

Obligatorios: `schemaVersion`, `id`, `title`, `created`, `goal`, al menos un criterio en `acceptance` y una política `verification` con comandos o evidencia manual. `definitions` es opcional y repetible.

## DefinitionRef

```json
{
  "kind": "spec",
  "path": "docs/product/export-csv.md"
}
```

`kind` es `spec` o `adr`. `path` es una ruta relativa a un archivo regular que ya existe dentro del repositorio. No se exige extensión, frontmatter, encabezados ni estructura editorial. No puede apuntar a `.stonvik/`, `product/inbox/` ni `features/`, ni atravesar enlaces simbólicos.

## ActorRef

```json
{
  "type": "agent",
  "name": "codex",
  "role": "implementer",
  "version": "2026.09"
}
```

Valores de `type`: `human`, `agent`, `ci` y `process`. Los roles disponibles son `triager`, `implementer`, `specifier`, `verifier`, `reviewer` y `product-owner`. La identidad declarada es procedencia, no credencial.

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

`outcome` acepta `completed`, `blocked`, `needs_human` o `cancelled`. `completed` nunca equivale a verificación ni aprobación. Los paths locales de `artifacts` y `evidence.ref` deben existir; también se permiten URLs de evidencia.

## WorkHandoff

El handoff JSON contiene:

- `work`: ID, título, objetivo, aceptación, restricciones y referencias;
- `execution`: paths permitidos y política de verificación;
- `protocol`: comandos de reporte y `ship`.

Es una vista generada y no cambia el estado del repositorio. No contiene prompts, modelos ni comandos de una herramienta editorial.

## RoutingDecision

```json
{
  "schemaVersion": 1,
  "inboxId": "inbox-2026-09-13T10:00:00.000Z-abc123",
  "route": "spec",
  "signals": {
    "size": "M",
    "estimatedTouchedFiles": 4,
    "risks": ["public_api"]
  },
  "rationale": ["El cambio requiere una decisión explícita."],
  "decidedBy": {
    "type": "human",
    "name": "lean",
    "role": "triager"
  },
  "created": "2026-09-13T10:00:00.000Z"
}
```

La ruta es `direct`, `spec` o `adr`. Triage puede recibir señales explícitas (`--size`, `--touched-files`, `--risk`) y la política determinista valida su coherencia.

## Persistencia

- `product/inbox/`: intención cruda y decisiones de triage.
- `features/ready|doing|review|blocked|done/`: directorios completos de Work.
- `receipts/`: evidencia append-only asociada a cada Work.
- `product/events/`: streams de eventos durables.
- `.stonvik/runtime/claims/`: claims locales y efímeros.
