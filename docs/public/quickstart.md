# Quickstart

## 1. Inicializar y capturar intención

```bash
npx stonvik init
npx stonvik capture "Agregar exportación CSV" --source human:terminal
npx stonvik --json capture "Agregar exportación CSV" --source human:terminal
```

La respuesta JSON contiene el ID. Sustituirlo por `<inbox-id>` en los comandos siguientes.

## 2. Hacer triage

Para un cambio directo:

```bash
npx stonvik triage <inbox-id> \
  --route direct \
  --actor human:lean
```

Para un trabajo que necesita una decisión o documento adicional:

```bash
npx stonvik triage <inbox-id> \
  --route spec \
  --actor human:lean
```

Las rutas válidas son `direct`, `spec` y `adr`. Triage solo registra la decisión; no crea una spec, no crea un ADR y no ejecuta trabajo.

## 3. Definir el Work

El equipo crea sus documentos con el formato y la ubicación que prefiera. Pueden vivir en cualquier ruta segura dentro del repositorio, por ejemplo `docs/product/notifications.md` o `architecture/notifications-adr.md`.

```bash
npx stonvik define <inbox-id> \
  --goal "Permitir exportar los datos visibles a CSV" \
  --acceptance "El usuario puede descargar un CSV" \
  --verify-command "npm test -- --runInBand" \
  --spec docs/product/export-csv.md \
  --adr architecture/export-csv.md
```

`--spec` y `--adr` son repetibles. Stonvik comprueba que cada archivo exista, sea relativo al repositorio y no apunte a `.stonvik/`, `product/inbox/` o `features/`. No interpreta su contenido ni exige frontmatter.

El resultado crea `features/ready/<slug>/manifest.yaml`. El manifest es el contrato ejecutable y contiene título, objetivo, aceptación, política de verificación y referencias documentales.

## 4. Reclamar y ejecutar

```bash
npx stonvik --json next
npx stonvik work start <work-id> \
  --actor agent:codex \
  --run-id agent-codex-001
npx stonvik work handoff <work-id> --format json > handoff.json
```

El actor implementa usando su propio proceso y modifica únicamente los archivos de producto necesarios. No debe modificar manifests, receipts, claims, `product/` ni `features/` para alterar el workflow.

Al terminar, escribe un reporte JSON:

```json
{
  "schemaVersion": 1,
  "actor": {
    "type": "agent",
    "name": "codex",
    "role": "implementer"
  },
  "outcome": "completed",
  "summary": "Implementé la exportación CSV y actualicé las pruebas.",
  "artifacts": [],
  "evidence": []
}
```

Y lo registra:

```bash
npx stonvik work report <work-id> --receipt result.json
```

`completed` solo indica que el actor terminó. El Work sigue en `doing` hasta pasar los gates posteriores.

## 5. Verificar, revisar y enviar

```bash
npx stonvik verify <work-id>
npx stonvik work review <work-id> \
  --actor human:reviewer \
  --decision approved \
  --summary "La implementación satisface el contrato."
npx stonvik ship <work-id>
```

`verify` ejecuta los comandos declarados en `manifest.yaml`. Un review aprobado deja el Work en `review`; `ship` exige una ejecución completada, verificación aprobada y review independiente antes de moverlo a `done`.

Si se solicitan cambios, el review mueve el Work a `doing` para que otro intento pueda reclamarlo:

```bash
npx stonvik work review <work-id> \
  --actor human:reviewer \
  --decision changes_requested \
  --summary "Falta cubrir el caso vacío."
```

## 6. Comprobar el repositorio

```bash
npx stonvik --json status
npx stonvik --json validate
```

Con `--json`, los errores de dominio se emiten en `stderr` con `error.code` y el proceso devuelve un exit code distinto de cero.
